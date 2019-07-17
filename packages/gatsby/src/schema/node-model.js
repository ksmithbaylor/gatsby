// @flow

const _ = require(`lodash`)
const {
  isAbstractType,
  GraphQLOutputType,
  GraphQLUnionType,
  GraphQLList,
  getNamedType,
  getNullableType,
  isCompositeType,
} = require(`graphql`)
const invariant = require(`invariant`)
const reporter = require(`gatsby-cli/lib/reporter`)

type IDOrNode = string | { id: string }
type TypeOrTypeName = string | GraphQLOutputType

/**
 * Optional page dependency information.
 *
 * @typedef {Object} PageDependencies
 * @property {string} path The path of the page that depends on the retrieved nodes' data
 * @property {string} [connectionType] Mark this dependency as a connection
 */
interface PageDependencies {
  path: string;
  connectionType?: string;
}

interface QueryArguments {
  type: TypeOrTypeName;
  query: { filter: Object, sort?: Object, skip?: number, limit?: number };
  firstOnly?: boolean;
}

export interface NodeModel {
  getNodeById(
    { id: IDOrNode, type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): any | null;
  getNodesByIds(
    { ids: Array<IDOrNode>, type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): Array<any>;
  getAllNodes(
    { type?: TypeOrTypeName },
    pageDependencies?: PageDependencies
  ): Array<any>;
  runQuery(
    args: QueryArguments,
    pageDependencies?: PageDependencies
  ): Promise<any>;
  getTypes(): Array<string>;
  trackPageDependencies<nodeOrNodes: Node | Node[]>(
    result: nodeOrNodes,
    pageDependencies?: PageDependencies
  ): nodesOrNodes;
  findRootNodeAncestor(obj: any, predicate: () => boolean): Node | null;
  trackInlineObjectsInRootNode(node: Node, sanitize: boolean): Node;
}

class LocalNodeModel {
  constructor({
    schema,
    schemaComposer,
    nodeStore,
    createPageDependency,
    path,
  }) {
    this.schema = schema
    this.schemaComposer = schemaComposer
    this.nodeStore = nodeStore
    this.createPageDependency = createPageDependency
    this.path = path

    this._rootNodeMap = new WeakMap()
    this._prepareNodesQueues = {}
    this._prepareNodesPromises = {}
  }

  /**
   * Get a node from the store by ID and optional type.
   *
   * @param {Object} args
   * @param {string} args.id ID of the requested node
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the node
   * @param {PageDependencies} [pageDependencies]
   * @returns {(Node|null)}
   */
  getNodeById(args, pageDependencies) {
    const { id, type } = args || {}

    const node = getNodeById(this.nodeStore, id)

    let result
    if (!node) {
      result = null
    } else if (!type) {
      result = node
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      result = nodeTypeNames.includes(node.internal.type) ? node : null
    }

    if (result) {
      this.trackInlineObjectsInRootNode(node)
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  /**
   * Get nodes from the store by IDs and optional type.
   *
   * @param {Object} args
   * @param {string[]} args.ids IDs of the requested nodes
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the nodes
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node[]}
   */
  getNodesByIds(args, pageDependencies) {
    const { ids, type } = args || {}

    const nodes = Array.isArray(ids)
      ? ids.map(id => getNodeById(this.nodeStore, id)).filter(Boolean)
      : []

    let result
    if (!nodes.length || !type) {
      result = nodes
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      result = nodes.filter(node => nodeTypeNames.includes(node.internal.type))
    }

    if (result) {
      result.forEach(node => this.trackInlineObjectsInRootNode(node))
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  /**
   * Get all nodes in the store, or all nodes of a specified type. Note that
   * this doesn't add tracking to all the nodes, unless pageDependencies are
   * passed.
   *
   * @param {Object} args
   * @param {(string|GraphQLOutputType)} [args.type] Optional type of the nodes
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node[]}
   */
  getAllNodes(args, pageDependencies) {
    const { type } = args || {}

    let result
    if (!type) {
      result = this.nodeStore.getNodes()
    } else {
      const nodeTypeNames = toNodeTypeNames(this.schema, type)
      const nodes = nodeTypeNames.reduce(
        (acc, typeName) => acc.concat(this.nodeStore.getNodesByType(typeName)),
        []
      )
      result = nodes.filter(Boolean)
    }

    if (result) {
      result.forEach(node => this.trackInlineObjectsInRootNode(node))
    }

    if (pageDependencies) {
      return this.trackPageDependencies(result, pageDependencies)
    } else {
      return result
    }
  }

  /**
   * Get nodes of a type matching the specified query.
   *
   * @param {Object} args
   * @param {Object} args.query Query arguments (`filter`, `sort`, `limit`, `skip`)
   * @param {(string|GraphQLOutputType)} args.type Type
   * @param {boolean} [args.firstOnly] If true, return only first match
   * @param {PageDependencies} [pageDependencies]
   * @returns {Promise<Node[]>}
   */
  async runQuery(args, pageDependencies) {
    const { query, firstOnly, type } = args || {}

    // We don't support querying union types (yet?), because the combined types
    // need not have any fields in common.
    const gqlType = typeof type === `string` ? this.schema.getType(type) : type
    invariant(
      !(gqlType instanceof GraphQLUnionType),
      `Querying GraphQLUnion types is not supported.`
    )

    const fields = getQueryFields({
      filter: query.filter,
      sort: query.sort,
      group: query.group,
      distinct: query.distinct,
    })
    const fieldsToResolve = determineResolvableFields(
      this.schemaComposer,
      this.schema,
      gqlType,
      fields
    )
    await this.prepareNodes(gqlType, fields, fieldsToResolve)

    const queryResult = await this.nodeStore.runQuery({
      queryArgs: query,
      firstOnly,
      gqlSchema: this.schema,
      gqlComposer: this.schemaComposer,
      gqlType,
      resolvedFields: fieldsToResolve,
    })

    let result = queryResult
    if (args.firstOnly) {
      if (result && result.length > 0) {
        result = result[0]
        this.trackInlineObjectsInRootNode(result)
      } else {
        result = null
      }
    } else if (result) {
      result.forEach(node => this.trackInlineObjectsInRootNode(node))
    }

    return this.trackPageDependencies(result, pageDependencies)
  }

  prepareNodes(type, queryFields, fieldsToResolve) {
    const typeName = type.name
    if (!this._prepareNodesQueues[typeName]) {
      this._prepareNodesQueues[typeName] = []
    }

    this._prepareNodesQueues[typeName].push({
      queryFields,
      fieldsToResolve,
    })

    if (!this._prepareNodesPromises[typeName]) {
      this._prepareNodesPromises[typeName] = new Promise(resolve => {
        process.nextTick(async () => {
          await this._doResolvePrepareNodesQueue(type)
          resolve()
        })
      })
    }

    return this._prepareNodesPromises[typeName]
  }

  async _doResolvePrepareNodesQueue(type) {
    const typeName = type.name
    const queue = this._prepareNodesQueues[typeName]
    this._prepareNodesQueues[typeName] = []
    this._prepareNodesPromises[typeName] = null

    const { queryFields, fieldsToResolve } = queue.reduce(
      (
        { queryFields, fieldsToResolve },
        { queryFields: nextQueryFields, fieldsToResolve: nextFieldsToResolve }
      ) => {
        return {
          queryFields: _.merge(queryFields, nextQueryFields),
          fieldsToResolve: _.merge(fieldsToResolve, nextFieldsToResolve),
        }
      },
      {
        queryFields: {},
        fieldsToResolve: {},
      }
    )

    // console.log(type, queryFields, fieldsToResolve)

    if (!_.isEmpty(fieldsToResolve)) {
      await this.nodeStore.updateNodesByType(type.name, async node => {
        this.trackInlineObjectsInRootNode(node)
        const resolvedFields = await resolveRecursive(
          this,
          this.schemaComposer,
          this.schema,
          node,
          type,
          queryFields,
          fieldsToResolve
        )
        const newNode = {
          ...node,
          $resolved: _.merge(node.$resolved || {}, resolvedFields),
        }
        return newNode
      })
    }
  }

  /**
   * Get the names of all node types in the store.
   *
   * @returns {string[]}
   */
  getTypes() {
    return this.nodeStore.getTypes()
  }

  /**
   * Adds link between inline objects/arrays contained in Node object
   * and that Node object.
   * @param {Node} node Root Node
   */
  trackInlineObjectsInRootNode(node) {
    return addRootNodeToInlineObject(
      this._rootNodeMap,
      node,
      node.id,
      true,
      true
    )
  }

  /**
   * Finds top most ancestor of node that contains passed Object or Array
   * @param {(Object|Array)} obj Object/Array belonging to Node object or Node object
   * @param {nodePredicate} [predicate] Optional callback to check if ancestor meets defined conditions
   * @returns {Node} Top most ancestor if predicate is not specified
   * or first node that meet predicate conditions if predicate is specified
   */
  findRootNodeAncestor(obj, predicate = null) {
    let iterations = 0
    let node = obj

    while (iterations++ < 100) {
      if (predicate && predicate(node)) return node

      const parent = node.parent && getNodeById(this.nodeStore, node.parent)
      const id = this._rootNodeMap.get(node)
      const trackedParent = id && getNodeById(this.nodeStore, id)

      if (!parent && !trackedParent) return node

      node = parent || trackedParent
    }

    reporter.error(
      `It looks like you have a node that's set its parent as itself:\n\n` +
        node
    )
    return null
  }

  /**
   * Given a result, that's either a single node or an array of them, track them
   * using pageDependencies. Defaults to tracking according to current resolver
   * path. Returns the result back.
   *
   * @param {Node | Node[]} result
   * @param {PageDependencies} [pageDependencies]
   * @returns {Node | Node[]}
   */
  trackPageDependencies(result, pageDependencies) {
    const fullDependencies = {
      path: this.path,
      ...(pageDependencies || {}),
    }
    const { path, connectionType } = fullDependencies
    if (path) {
      if (connectionType) {
        this.createPageDependency({ path, connection: connectionType })
      } else {
        const nodes = Array.isArray(result) ? result : [result]
        nodes
          .filter(Boolean)
          .map(node => this.createPageDependency({ path, nodeId: node.id }))
      }
    }

    return result
  }
}

const getNodeById = (nodeStore, id) => {
  // This is for cases when the `id` has already been resolved
  // to a full Node for the input filter, and is also in the selection
  // set. E.g. `{ foo(parent: { id: { eq: 1 } } ) { parent { id } } }`.
  if (_.isPlainObject(id) && id.id) {
    return id
  }
  return id != null ? nodeStore.getNode(id) : null
}

const toNodeTypeNames = (schema, gqlTypeName) => {
  const gqlType =
    typeof gqlTypeName === `string` ? schema.getType(gqlTypeName) : gqlTypeName

  if (!gqlType) return []

  const possibleTypes = isAbstractType(gqlType)
    ? schema.getPossibleTypes(gqlType)
    : [gqlType]

  return possibleTypes
    .filter(type => type.getInterfaces().some(iface => iface.name === `Node`))
    .map(type => type.name)
}

const getQueryFields = ({ filter, sort, group, distinct }) => {
  const filterFields = filter ? dropQueryOperators(filter) : {}
  const sortFields = (sort && sort.fields) || []

  if (group && !Array.isArray(group)) {
    group = [group]
  } else if (group == null) {
    group = []
  }

  if (distinct && !Array.isArray(distinct)) {
    distinct = [distinct]
  } else if (distinct == null) {
    distinct = []
  }

  return merge(
    filterFields,
    ...sortFields.map(pathToObject),
    ...group.map(pathToObject),
    ...distinct.map(pathToObject)
  )
}

const pathToObject = path => {
  if (path && typeof path === `string`) {
    return path.split(`.`).reduceRight((acc, key) => {
      return { [key]: acc }
    }, true)
  }
  return {}
}

const dropQueryOperators = filter =>
  Object.keys(filter).reduce((acc, key) => {
    const value = filter[key]
    const k = Object.keys(value)[0]
    const v = value[k]
    if (_.isPlainObject(value) && _.isPlainObject(v)) {
      acc[key] =
        k === `elemMatch` ? dropQueryOperators(v) : dropQueryOperators(value)
    } else {
      acc[key] = true
    }
    return acc
  }, {})

const mergeObjects = (obj1, obj2) =>
  Object.keys(obj2).reduce((acc, key) => {
    const value = obj2[key]
    if (typeof value === `object` && value && acc[key]) {
      acc[key] = mergeObjects(acc[key], value)
    } else {
      acc[key] = value
    }
    return acc
  }, obj1)

const merge = (...objects) => {
  const [first, ...rest] = objects.filter(Boolean)
  return rest.reduce((acc, obj) => mergeObjects(acc, obj), { ...first })
}

async function resolveRecursive(
  nodeModel,
  schemaComposer,
  schema,
  node,
  type,
  queryFields,
  fieldsToResolve
) {
  const gqlFields = type.getFields()
  let resolvedFields = {}
  for (const fieldName of Object.keys(fieldsToResolve)) {
    const fieldToResolve = fieldsToResolve[fieldName]
    const queryField = queryFields[fieldName]
    const gqlField = gqlFields[fieldName]
    const gqlNonNullType = getNullableType(gqlField.type)
    const gqlFieldType = getNamedType(gqlField.type)
    let innerValue
    if (gqlField.resolve) {
      innerValue = await resolveField(
        nodeModel,
        schemaComposer,
        schema,
        node,
        gqlField,
        fieldName
      )
    } else {
      innerValue = node[fieldName]
    }
    if (gqlField && innerValue != null) {
      if (
        isCompositeType(gqlFieldType) &&
        !(gqlNonNullType instanceof GraphQLList)
      ) {
        innerValue = await resolveRecursive(
          nodeModel,
          schemaComposer,
          schema,
          innerValue,
          gqlFieldType,
          queryField,
          _.isObject(fieldToResolve) ? fieldToResolve : queryField
        )
      } else if (
        isCompositeType(gqlFieldType) &&
        _.isArray(innerValue) &&
        gqlNonNullType instanceof GraphQLList
      ) {
        innerValue = await Promise.all(
          innerValue.map(item =>
            resolveRecursive(
              nodeModel,
              schemaComposer,
              schema,
              item,
              gqlFieldType,
              queryField,
              _.isObject(fieldToResolve) ? fieldToResolve : queryField
            )
          )
        )
      }
    }
    if (innerValue != null) {
      resolvedFields[fieldName] = innerValue
    }
  }

  Object.keys(queryFields).forEach(key => {
    if (!fieldsToResolve[key] && node[key]) {
      resolvedFields[key] = node[key]
    }
  })

  return _.pickBy(resolvedFields, (value, key) => queryFields[key])
}

function resolveField(
  nodeModel,
  schemaComposer,
  schema,
  node,
  gqlField,
  fieldName
) {
  return gqlField.resolve(
    node,
    {},
    {
      nodeModel,
    },
    {
      fieldName,
      schema,
      returnType: gqlField.type,
    }
  )
}

const determineResolvableFields = (schemaComposer, schema, type, fields) => {
  const fieldsToResolve = {}
  const gqlFields = type.getFields()
  Object.keys(fields).forEach(fieldName => {
    const field = fields[fieldName]
    const gqlField = gqlFields[fieldName]
    const gqlFieldType = getNamedType(gqlField.type)
    const typeComposer = schemaComposer.getAnyTC(type.name)
    const needsResolve = typeComposer.getFieldExtension(
      fieldName,
      `needsResolve`
    )
    if (_.isObject(field) && gqlField) {
      const innerResolved = determineResolvableFields(
        schemaComposer,
        schema,
        gqlFieldType,
        field
      )
      if (!_.isEmpty(innerResolved)) {
        fieldsToResolve[fieldName] = innerResolved
      } else if (_.isEmpty(innerResolved) && needsResolve) {
        fieldsToResolve[fieldName] = true
      }
    } else if (needsResolve) {
      fieldsToResolve[fieldName] = true
    }
  })
  return fieldsToResolve
}

/**
 * Add link between passed data and Node. This function shouldn't be used
 * directly. Use higher level `trackInlineObjectsInRootNode`
 * @see trackInlineObjectsInRootNode
 * @param {(Object|Array)} data Inline object or array
 * @param {string} nodeId Id of node that contains data passed in first parameter
 */
const addRootNodeToInlineObject = (
  rootNodeMap,
  data,
  nodeId,
  isNode = false
) => {
  const isPlainObject = _.isPlainObject(data)

  if (isPlainObject || _.isArray(data)) {
    _.each(data, (o, key) => {
      if (isNode && key === `internal`) {
        return
      } else {
        addRootNodeToInlineObject(rootNodeMap, o, nodeId)
      }
    })
    // don't need to track node itself
    if (!isNode) {
      rootNodeMap.set(data, nodeId)
    }
  }
}

module.exports = {
  LocalNodeModel,
}
