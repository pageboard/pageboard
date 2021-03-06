const objection = require('objection');
const Model = objection.Model;
const common = require('./common');

class Href extends common.Model {}

module.exports = Href;

Href.useLimitInFirst = true;

Href.tableName = 'href';

Href.idColumn = '_id';

Href.jsonSchema = {
	type: 'object',
	required: ['url', 'mime'],
	$id: '/api/href',
	properties: {
		updated_at: {
			type: 'string',
			format: 'date-time'
		},
		mime: {
			type: 'string'
		},
		visible: {
			type: 'boolean',
			default: true
		},
		url: {
			type: 'string',
			format: 'uri-reference',
			nullable: true
		},
		canonical: {
			type: 'string',
			format: 'uri-reference',
			nullable: true
		},
		type: {
			type: 'string'
		},
		title: {
			type: 'string'
		},
		icon: {
			type: 'string',
			format: 'uri-reference',
			nullable: true
		},
		site: {
			type: 'string'
		},
		pathname: {
			type: 'string'
		},
		lang: {
			nullable: true,
			type: "string"
		},
		preview: {
			nullable: true,
			type: "string"
		},
		meta: {
			type: 'object',
			default: {},
			properties: {
				size: {
					nullable: true,
					type: "integer"
				},
				width: {
					nullable: true,
					type: "integer"
				},
				height: {
					nullable: true,
					type: "integer"
				},
				duration: {
					nullable: true,
					type: "string",
					format: "time"
				}
			}
		}
	}
};

Href.columns = Object.keys(Href.jsonSchema.properties);

Href.prototype.$beforeUpdate = function() {
	this.updated_at = new Date().toISOString();
};

Href.relationMappings = {
	parent: {
		relation: Model.BelongsToOneRelation,
		modelClass: __dirname + '/block',
		join: {
			from: 'href._parent_id',
			to: 'block._id'
		}
	}
};

Href.QueryBuilder = class HrefQueryBuilder extends common.QueryBuilder {
	whereSite(id) {
		return this.joinRelated('parent')
		.where('parent.type', 'site')
		.where('parent.id', id);
	}
};

