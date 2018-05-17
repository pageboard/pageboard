var ref = require('objection').ref;

exports = module.exports = function(opt) {
	return {
		name: 'block',
		service: init
	};
};

function init(All) {
	All.app.get("/.api/block", function(req, res, next) {
		var type = req.query.type;
		if (!type || ['user', 'site', 'page'].indexOf(type) >= 0) {
			return next(new HttpError.BadRequest("Cannot request that type"));
		}
		All.run('block.get', req.site, req.query).then(function(data) {
			res.json(data);
		}).catch(next);
	});
}

exports.get = function(site, data) {
	var q = site.$relatedQuery('children').select()
		.where('block.id', data.id);
	if (data.type) q.where('block.type', data.type);
	if (data.standalone) q.eager(`[children(childrenFilter)]`, {
		childrenFilter: function(query) {
			return query.select().where('block.standalone', false);
		}
	});
	return q.first().throwIfNotFound();
};
exports.get.schema = {
	required: ['id'],
	properties: {
		id: {
			type: 'string'
		},
		type: {
			type: 'string'
		},
		standalone: {
			type: 'boolean',
			default: false
		}
	},
	additionalProperties: false
};

exports.search = function(site, data) {
	var q = site.$relatedQuery('children').select()
		.where('block.type', data.type);
	if (data.parent) {
		q.joinRelation('parents', {alias: 'parent'}).where('parent.id', data.parent);
	}
	if (data.parents) q.eager('[parents(parentFilter)]', {
		parentFilter: function(query) {
			query.select();
			if (data.parents.type) query.whereIn('block.type', data.parents.type);
		}
	});
	if (data.children) q.eager('[children(childrenFilter)]', {
		childrenFilter: function(query) {
			query.select();
			if (data.children.type) query.whereIn('block.type', data.children.type);
			if (data.children.order) data.children.order.forEach(function(order) {
				var {col, dir} = parseOrder('block', order);
				query.orderBy(col, dir);
			});
		}
	});
	var schemas = {};
	[data.type].concat(data.children && data.children.type || [])
	.concat(data.parents && data.parents.type || [])
	.forEach(function(type) {
		var sch = site.$schema(type);
		if (sch) schemas[type] = sch;
		else console.warn(`Unknown schema for type '${type}'`);
	});
	if (data.id) {
		q.where('block.id', data.id);
	}
	if (data.data) {
		q.whereObject({data: data.data}, schemas[data.type]);
	}
	if (data.text != null) {
		var text = data.text.split(/\W+/).filter(x => !!x).map(x => x + ':*').join(' <-> ');
		q.from(Block.raw([
			Block.raw("to_tsquery('unaccent', ?) AS query", [text]),
			'block'
		]));
		q.whereRaw('query @@ block.tsv');
		q.orderByRaw('ts_rank(block.tsv, query) DESC');
	}
	if (data.order) data.order.forEach(function(order) {
		var {col, dir} = parseOrder('block', order);
		q.orderBy(col, dir);
	});
	q.orderBy('updated_at', 'block.asc');
	q.offset(data.offset).limit(data.limit);
	return q.then(function(rows) {
		var obj = {
			data: rows,
			offset: data.offset,
			limit: data.limit,
			schemas: schemas
		};
		if (data.parents && data.parents.first) {
			rows.forEach(function(row) {
				row.parent = row.parents[0];
				delete row.parents;
			});
		}
		return obj;
	});
};
exports.search.schema = {
	required: ['type'],
	properties: {
		text: {
			type: 'string'
		},
		parent: {
			type: 'string'
		},
		parents: {
			type: 'object',
			required: ['type'],
			properties: {
				first: {
					type: 'boolean',
					default: false
				},
				type: {
					type: 'array',
					items: {
						type: 'string',
						not: { // TODO permissions should be managed dynamically
							oneOf: [{
								const: "user"
							}, {
								const: "site"
							}]
						}
					}
				}
			}
		},
		id: {
			type: 'string'
		},
		data: {
			type: 'object'
		},
		type: {
			type: 'string',
			not: { // TODO permissions should be managed dynamically
				oneOf: [{
					const: "user"
				}, {
					const: "site"
				}]
			}
		},
		children: {
			type: 'object',
			required: ['type'],
			properties: {
				type: {
					type: 'array',
					items: {
						type: 'string',
						not: { // TODO permissions should be managed dynamically
							oneOf: [{
								const: "user"
							}, {
								const: "site"
							}]
						}
					}
				},
				order: {
					type: 'array',
					items: {
						type: 'string'
					}
				}
			}
		},
		order: {
			type: 'array',
			items: {
				type: 'string'
			}
		},
		limit: {
			type: 'integer',
			minimum: 0,
			maximum: 50,
			default: 10
		},
		offset: {
			type: 'integer',
			minimum: 0,
			default: 0
		}
	},
	additionalProperties: false
};
exports.search.external = true;

exports.find = function(site, data) {
	data.limit = 1;
	data.offset = 0;
	return exports.search(site, data).then(function(obj) {
		return {
			data: obj.data.length == 1 ? obj.data[0] : null,
			schemas: obj.schemas
		};
	});
};
exports.find.schema = {
	required: ['id', 'type'],
	properties: {
		id: {
			type: 'string'
		},
		type: {
			type: 'string',
			not: { // TODO permissions should be managed dynamically
				oneOf: [{
					const: "user"
				}, {
					const: "site"
				}]
			}
		},
		children: exports.search.schema.properties.children,
		parent: exports.search.schema.properties.parent,
		parents: exports.search.schema.properties.parents
	},
	additionalProperties: false
};
exports.find.external = true;

exports.add = function(site, data) {
	var id = data.parent;
	delete data.parent;
	return site.$relatedQuery('children').insert(data).then(function(child) {
		if (!id) return child;
		return site.$relatedQuery('children').where('block.id', id)
		.first().throwIfNotFound().then(function(parent) {
			return parent.$relatedQuery('children').relate(child).then(function() {
				return child;
			});
		});
	});
};
exports.add.schema = {
	properties: {
		parent: {
			type: 'string'
		}
	},
	additionalProperties: true
};
exports.add.external = true;

exports.save = function(site, data) {
	return exports.get(site, data).forUpdate().then(function(block) {
		return site.$relatedQuery('children').patchObject(data)
		.where('block.id', block.id).then(function(count) {
			if (count == 0) throw new Error(`Block not found for update ${data.id}`);
		});
	});
};
exports.save.schema = {
	required: ['id', 'type'],
	properties: {
		id: {
			type: 'string'
		},
		type: {
			type: 'string'
		}
	},
	additionalProperties: true
};
exports.save.external = true;

exports.del = function(site, data) {
	return site.$relatedQuery('children')
		.where('block.id', data.id)
		.whereIn('block.type', data.type)
		.delete();
};
exports.del.schema = {
	required: ['id', 'type'],
	properties: {
		id: {
			type: 'string'
		},
		type: {
			type: 'array',
			items: {
				type: 'string',
				not: { // TODO permissions should be managed dynamically
					oneOf: [{
						const: "user"
					}, {
						const: "site"
					}]
				}
			}
		}
	},
	additionalProperties: false
};
exports.del.external = true;

exports.gc = function(days) {
	return All.api.Block.raw(`DELETE FROM block USING (
		SELECT count(relation.child_id), b._id FROM block AS b
			LEFT OUTER JOIN relation ON (relation.child_id = b._id)
			LEFT JOIN block AS p ON (p._id = relation.parent_id AND p.type='site')
		WHERE b.type NOT IN ('user', 'site') AND extract('day' from now() - b.updated_at) >= ?
		GROUP BY b._id
	) AS usage WHERE usage.count = 0 AND block._id = usage._id`, [
		days
	]).then(function(result) {
		return {
			length: result.rowCount
		};
	});
};

function parseOrder(table, str) {
	var col = str;
	var dir = 'asc';
	if (col.startsWith('-')) {
		dir = 'desc';
		col = col.substring(1);
	}
	var list = col.split('.');
	var first = list.shift();
	col = `${table}.${first}`;
	if (list.length > 0) col += `:${list.join('.')}`;
	return {col: ref(col), dir};
}

