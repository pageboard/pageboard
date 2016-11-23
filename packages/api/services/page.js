exports = module.exports = function(config) {
	return {
		name: 'page',
		service: init
	};
};

function init(All) {
	All.app.post('/api/page', function(req, res, next) {
		exports.create(req.body).then(function(page) {
			res.sendStatus(200);
		}).catch(next);
	});
}

exports.get = function(data) {
	return All.Block.query().where({
		url: data.url,
		type: 'page',
		mime: 'text/html'
	}).eager('children.^')
	.joinRelation('site').where('site.domain', data.domain).first();
};

exports.create = function(data) {
	data = Object.assign({
		type: 'page',
		mime: 'text/html'
	}, data);
	return All.Site.query().where('domain', data.domain).first().then(function(site) {
		data.site_id = site.id;
		return All.Block.query().insert(data);
	});
};



exports.remove = function(data) {
	if (!data.url || !data.domain) {
		return Promise.reject(new HttpError.BadRequest("Missing url"));
	}

	return All.Block.query().del().where(url, data.url)
		.joinRelation('site').where('site.domain', data.domain);
};

