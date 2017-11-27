var equal = require('esequal');

exports = module.exports = function(opt) {
	return {
		name: 'site',
		service: init
	};
};

function init(All) {
	All.app.get('/.api/site', All.query, function(req, res, next) {
		exports.get(req.query).then(function(site) {
			res.send(site);
		}).catch(next);
	});
	All.app.post('/.api/site', All.body, function(req, res, next) {
		exports.add(req.body).then(function(site) {
			res.send(site);
		}).catch(next);
	});
	All.app.put('/.api/site', All.body, function(req, res, next) {
		exports.save(req.body).then(function(site) {
			res.send(site);
		}).catch(next);
	});
	All.app.delete('/.api/site', All.query, function(req, res, next) {
		exports.del(req.query).then(function(site) {
			res.send(site);
		}).catch(next);
	});
}

function QuerySite(data) {
	var q = All.api.Block.query();
	if (data.id) {
		q.where('id', data.id);
	} else {
		if (!data.domain) throw new HttpError.BadRequest("Missing domain");
		q.whereJsonText('block.data:domain', data.domain).where('block.type', 'site');
	}
	return q;
}

exports.get = function(data) {
	return QuerySite(data).select('block.*').first().then(function(site) {
		if (!site) throw new HttpError.NotFound("No site found");
		return site;
	});
};

exports.add = function(data) {
	if (!data.user) throw new HttpError.BadRequest("Missing user");
	data = Object.assign({
		type: 'site'
	}, data);
	return All.user.get({
		type: 'user',
		email: data.user
	}).select('_id').then(function(user) {
		data.parents = [{
			'#dbRef': user._id
		}];
		data.children = [{
			'#dbRef': user._id // a user is also child of its own site
		}, {
			type: 'notfound',
			standalone: true
		}];
		delete data.user;
		return All.api.Block.query().insertGraph(data);
	});
};

exports.save = function(data) {
	return exports.get(data).then(function(site) {
		if (data.domain) delete data.domain;
		var sameDeps = equal(
			data.data && data.data.dependencies || null,
			site.data && site.data.dependencies || null
		);
		// ensure we don't just empty site.data by mistake
		data.data = Object.assign({}, site.data, data.data);
		return site.$query().where('id', site.id).patch(data).then(function(result) {
			if (sameDeps == false) return All.install(data.data).then(() => result);
			else return result;
		});
	});
};

exports.del = function(data) {
	return QuerySite(data).del();
};

