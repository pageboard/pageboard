Pageboard.elements.site = {
	properties : {
		title: {
			title: 'Site title',
			type: 'string' // the site public name
		},
		domain: {
			title: 'Domain name',
			type: 'string',
			format: 'hostname'
		},
		lang: {
			title: 'Language',
			type: ["string", "null"]
		},
		module: {
			title: 'Module name',
			type: 'string'
		},
		version: {
			title: 'Module version',
			type: 'string'
		},
		env: {
			title: 'Environment',
			anyOf: [{
				const: 'dev',
				title: 'Development'
			}, {
				const: 'staging',
				title: 'Staging'
			}, {
				const: 'production',
				title: 'Production'
			}],
			default: 'dev'
		},
		favicon: {
			title: 'Favicon',
			anyOf: [{
				type: "null"
			}, {
				type: "string",
				pattern: "^(/[\\w-.]*)+$"
			}],
			input: {
				name: 'href',
				display: 'icon',
				filter: {
					type: ["image", "svg"],
					maxSize: 20000,
					maxWidth: 320,
					maxHeight: 320
				}
			}
		}
	}
};

