Page.route(function(state) {
	return GET('/.api/page', {
		url: state.pathname
	}).catch(function(err) {
		// emergency error handling
		document.body.textContent = `${err.code} ${err}`;
		document.title = err.code;
		throw err;
	}).then(function(page) {
		var scripts = page.elements;
		delete page.elements;
		// this works around createHTMLDocument incompatibilities
		var doc = document.cloneNode(false);
		var html = doc.createElement('html');
		doc.appendChild(html);
		html.appendChild(doc.createElement('head'));
		html.appendChild(doc.createElement('body'));
		// --
		state.document = doc;
		state.data.page = page;

		scripts = [
			"/.pageboard/read/window-page.js",
			"/.pageboard/read/dom-template-strings.js",
			"/.pageboard/pagecut/viewer.js",
			"/.pageboard/pagecut/id.js",
			"/.pageboard/read/build.js"
		].concat(scripts);

		scripts.forEach(function(src) {
			var node = doc.createElement('script');
			node.setAttribute('src', src);
			doc.head.appendChild(doc.createTextNode('\n'));
			doc.head.appendChild(node);
		});
	}).catch(function(err) {
		// log client-side errors
		if (err) console.error(err);
	});
});

