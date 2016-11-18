var dom = require('express-dom');
var expressHref = require('express-href');

module.exports = function(plugins) {
	plugins.views.push(init);
};

function init(app, api, config) {
	expressHref(app);

	if (!config.dom) config.dom = {};

	Object.assign(dom.settings, {
		stall: 20000,
		allow: "same-origin"
	}, config.dom);

	Object.assign(dom.pool, {
		max: 8
	}, config.dom.pool);

	if (config.dom && config.dom.pool) delete dom.settings.pool;

	dom.helpers.bundle = require('./plugins/bundledom')(
		config.statics.path,
		process.env.DEVELOP ? "" : "bundles"
	);

	app.get('*', dom(template, dom.helpers.bundle).load());
};

function template(mw, settings, req, res) {
	// get page block
	// return template file name
	return 'front';
}
