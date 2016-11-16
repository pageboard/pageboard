var express = require('express');

exports.route = function(app, api, config) {
	app.get(/^\/(.*\.html|js|components|css|img|themes|uploads|fonts|bundles)/,
		express.static(config.statics.path, {
			maxAge: config.statics.maxAge * 1000
		}),
		function(req, res, next) {
			console.info("File not found", req.path);
			res.sendStatus(404);
		}
	);
};

