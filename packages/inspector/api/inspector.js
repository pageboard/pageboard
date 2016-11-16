var inspector = require('url-inspector');

exports.route = function(app, api, config) {
	app.get('/inspector', function(req, res, next) {
		inspector(req.query.url, config.inspector, function(err, info) {
			if (err) return next(err);
			res.send(info);
		})
	});
};

