const URL = require('url');

exports = module.exports = function(opt) {
	return {
		name: 'search',
		service: init
	};
};

function init(All) {
	All.app.get("/.api/query/:id", function(req, res, next) {
		All.run('search.query', req.site, {
			id: req.params.id,
			query: All.utils.unflatten(URL.parse(req.headers.referer, true).query)
		}).then(function(data) {
			res.json(data);
		}).catch(next);
	});
	All.app.post("/.api/query", function(req, res, next) {
		throw new HttpError.NotImplemented();
	});
}

exports.query = function(site, data) {
	return All.run('block.get', site, {
		id: data.id
	}).then(function(parent) {
		var fd = parent.data || {};
		if (!fd.method) throw new HttpError.BadRequest("Missing method");
		var params = All.utils.mergeParameters(fd.parameters, {
			$query: data.query
		});
		return All.run(fd.method, site, params);
	});
};

exports.query.schema = {
	$action: 'read',
	required: ['id'],
	properties: {
		id: {
			type: 'string'
		},
		query: {
			type: 'object'
		}
	},
	additionalProperties: false
};

