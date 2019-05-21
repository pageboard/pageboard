var dom = require('express-dom');

exports.helper = function(mw, settings, request, response) {
	if (request.path.endsWith('.pdf') == false) return;
	settings.pdf = {
		defaults: {
			paper: 'iso_a4',
			margins: '10mm'
		},
		mappings: {
		}
	};
	settings.load.plugins = [
		dom.plugins.bearer,
		dom.plugins.pdf
	];
};

exports.plugin = require('express-dom-pdf').plugin;
