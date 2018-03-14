var ref = require('objection').ref;

exports = module.exports = function(opt) {
	return {
		name: 'block',
		service: init
	};
};

function init(All) {
}

exports.get = function(data) {
	var Block = All.domain(data.domain).Block;
	var q = Block.query()
		.select(Block.tableColumns)
		.whereDomain(Block.domain)
		.where('block.id', data.id);
	if (data.type) q.where('block.type', data.type);
	return q.first().throwIfNotFound();
};
exports.get.schema = {
	required: ['id', 'domain'],
	properties: {
		id: {
			type: 'string'
		},
		domain: {
			type: 'string'
		},
		type: {
			type: 'string'
		}
	},
	additionalProperties: false
};

exports.search = function(data) {
	var Block = All.domain(data.domain).Block;
	var q = Block.query()
		.select(Block.tableColumns)
		.whereDomain(Block.domain)
		.whereIn('block.type', data.type);
	if (data.parent) {
		q.joinRelation('parents as parent').where('parent.id', data.parent);
	}
	if (data.children) q.eager('[children(childrenFilter)]', {
		childrenFilter: function(query) {
			return query.select(Block.tableColumns);
		}
	});
	if (data.id) {
		q.where('block.id', data.id);
	}
	if (data.data) {
		var refs = {};
		asPaths(data.data, refs, 'block.data:');
		for (var k in refs) {
			q.where(ref(k).castText(), Array.isArray(refs[k]) ? 'IN' : '=', refs[k]);
		}
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
	q.orderBy('updated_at', 'block.desc');
	q.offset(data.offset).limit(data.limit);
	return q.then(function(rows) {
		var obj = {
			data: rows,
			offset: data.offset,
			limit: data.limit
		};
		obj.schemas = {};
		data.type.forEach(function(type) {
			var sch = Block.schemaByType(type);
			if (sch) obj.schemas[type] = sch;
		});
		return obj;
	});
};
exports.search.schema = {
	required: ['domain', 'type'],
	properties: {
		text: {
			type: 'string'
		},
		parent: {
			type: 'string'
		},
		id: {
			type: 'string'
		},
		data: {
			type: 'object'
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
		},
		domain: {
			type: 'string'
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
		},
		children: {
			type: 'boolean',
			default: false
		}
	},
	additionalProperties: false
};

exports.find = function(data) {
	data.limit = 1;
	data.offset = 0;
	return exports.search(data).then(function(obj) {
		return {
			data: obj.data.length == 1 ? obj.data[0] : null,
			schemas: obj.schemas
		};
	});
};
exports.find.schema = {
	required: ['domain', 'id', 'type'],
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
		},
		domain: {
			type: 'string'
		},
		children: {
			type: 'boolean',
			default: false
		}
	},
	additionalProperties: false
};

exports.add = function(data) {
	var domain = data.domain;
	delete data.domain;
	var id = data.parent;
	delete data.parent;
	return All.domain(domain).Block.query().whereJsonText('block.data:domain', domain)
	.first().throwIfNotFound().then(function(site) {
		return site.$relatedQuery('children').insert(data).then(function(child) {
			if (!id) return child;
			return site.$relatedQuery('children').where('block.id', id)
			.select('_id').first().throwIfNotFound().then(function(parent) {
				return parent.$relatedQuery('children').relate(child);
			});
		});
	});
};
exports.add.schema = {
	required: ['domain'],
	properties: {
		domain: {
			type: 'string'
		},
		parent: {
			type: 'string'
		}
	},
	additionalProperties: true
};

exports.save = function(data) {
	return exports.get(data).then(function(block) {
		var domain = data.domain;
		delete data.domain;
		return All.domain(domain).Block.query()
		.patch(data).skipUndefined().where('block.id', block.id).then(function(count) {
			if (count == 0) throw new Error(`Block not found for update ${data.id}`);
		});
	});
};
exports.save.schema = {
	required: ['domain', 'id', 'type'],
	properties: {
		domain: {
			type: 'string'
		},
		id: {
			type: 'string'
		},
		type: {
			type: 'string'
		}
	},
	additionalProperties: true
};

exports.del = function(data) {
	var Block = All.domain(data.domain).Block;
	return Block.query().where('id',
		Block.query().select('block.id').where('block.id', data.id).whereDomain(data.domain)
	).delete();
};
exports.del.schema = {
	required: ['domain', 'id', 'type'],
	properties: {
		domain: {
			type: 'string'
		},
		id: {
			type: 'string'
		},
		type: {
			type: 'string'
		}
	},
	additionalProperties: false
};

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


function asPaths(obj, ret, pre) {
	if (!ret) ret = {};
	Object.keys(obj).forEach(function(key) {
		var val = obj[key];
		var cur = `${pre || ""}${key}`;
		if (Array.isArray(val) || typeof val != "object") {
			ret[cur] = val;
		} else if (typeof val == "object") {
			asPaths(val, ret, cur + '.');
		}
	});
	return ret;
}

