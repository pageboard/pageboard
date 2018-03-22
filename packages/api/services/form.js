var URL = require('url');

exports = module.exports = function(opt) {
	return {
		name: 'form',
		service: init
	};
};

function init(All) {
	All.app.get("/.api/form", function(req, res, next) {
		All.run('form.query', req.site, req.query).then(function(data) {
			res.json(data);
		}).catch(next);
	});
	All.app.post("/.api/form", function(req, res, next) {
		req.body._referer = req.headers.referer;
		All.run('form.submit', req.site, req.body).then(function(data) {
			if (data.redirect && req.accepts('html') && !req.xhr) {
				res.location(data.redirect);
			}	else {
				res.json(data);
			}
		}).catch(next);
	});
}

exports.query = function(site, data) {
	return All.run('block.get', site, {
		id: data._id
	}).then(function(form) {
		var fd = form.data.action || {};
		if (!fd.type) throw new HttpError.BadRequest("Missing form action.type");
		var id = fd.vars && fd.vars.id && data[fd.vars.id] || data.id;
		return All.run('block.get', site, {
			id: id,
			type: fd.type
		});
	});
};
exports.query.schema = {
	required: ["_id"],
	properties: {
		_id: {
			type: 'string'
		}
	}
};

exports.submit = function(site, data) {
	var referer = URL.parse(data._referer, true);
	delete data._referer;
	return All.run('block.get', site, {
		id: data._id
	}).then(function(form) {
		var fd = form.data.action || {};
		if (fd.method != "post") throw new HttpError.MethodNotAllowed("Only post allowed");
		delete data._id;

		var setVar = All.search.setVar;
		var getVar = All.search.getVar;
		var params = {}; // TODO import data using fd.type schema
		Object.keys(data).forEach(function(key) {
			setVar(params, key, data[key]);
		});
		if (fd.vars) Object.keys(fd.vars).forEach(function(key) {
			var val = getVar(data, fd.vars[key]);
			if (val === undefined) return;
			setVar(params, fd.vars[key]);
			setVar(params, key, val);
		});
		if (fd.type) {
			// when bound to an element, all keys are supposed to be in block.data
			var id = params.id;
			delete params.id;
			var parent = params.parent;
			delete params.parent;
			data = params;
			params = {
				id: id,
				type: fd.type
			};
			if (Object.keys(data).length > 0) {
				params.data = data;
			}
			if (parent) params.parent = parent;
		}
		// overwriting values
		if (fd.consts) Object.keys(fd.consts).forEach(function(key) {
			setVar(params, key, fd.consts[key]);
		});
		return All.run(fd.call, site, params).then(function(response) {
			if (typeof response != "obj") response = {};
			var fd = form.data.redirection;
			if (fd.url) {
				var query = {};
				var obj = URL.parse(fd.url);
				delete obj.path;
				obj.query = query;
				if (fd.vars) Object.keys(fd.vars).forEach(function(key) {
					var val = getVar(referer.query, fd.vars[key]);
					if (val === undefined) return;
					setVar(query, key, val);
				});
				if (fd.consts) Object.keys(fd.consts).forEach(function(key) {
					setVar(query, key, fd.consts[key]);
				});
				response.redirect = URL.format(obj);
			}
			return response;
		});
	});
};
exports.submit.schema = {
	required: ["_id"],
	properties: {
		_id: {
			type: 'string'
		}
	}
};

