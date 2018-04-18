if (!window.Pageboard) window.Pageboard = {};

// this works in babel 6, see postinstall-js
class HTMLCustomElement extends HTMLElement {
	constructor(me) {
		me = super(me);
		me.init();
		return me;
	}
	init() {}
}
HTMLCustomElement.define = function(name, cla) {
	if (!window.customElements.get(name)) window.customElements.define(name, cla);
};

Pageboard.fetch = function(method, url, data) {
	method = method.toLowerCase();
	var fetchOpts = {
		method: method,
		headers: {
			'Accept': 'application/json'
		},
		credentials: "same-origin"
	};
	var pendings = Pageboard.fetch.pendings;
	if (method == "get") {
		url = Page.format(Object.assign(Page.parse(url), {query: data}));
		var pending = pendings[url];
		if (pending) {
			return pending;
		}
	} else {
		fetchOpts.headers['Content-Type'] = 'application/json';
		fetchOpts.body = JSON.stringify(data);
	}

	var p = fetch(url, fetchOpts).then(function(res) {
		if (res.status >= 400) throw new Error(res.statusText);
		var len = res.headers.get('Content-Length');
		if (len > 0) return res.json();
		else return null;
	});
	if (method == "get") {
		pendings[url] = p;
		p.finally(function() {
			delete pendings[url];
		});
	}
	return p;
};
Pageboard.fetch.pendings = {};

Pageboard.debounce = function(func, wait, immediate) {
	var timeout, args, context, timestamp, result;
	if (null == wait) wait = 100;

	function later() {
		var last = Date.now() - timestamp;

		if (last < wait && last >= 0) {
			timeout = setTimeout(later, wait - last);
		} else {
			timeout = null;
			if (!immediate) {
				result = func.apply(context, args);
				context = args = null;
			}
		}
	}

	function debounced() {
		context = this;
		args = arguments;
		timestamp = Date.now();
		var callNow = immediate && !timeout;
		if (!timeout) timeout = setTimeout(later, wait);
		if (callNow) {
			result = func.apply(context, args);
			context = args = null;
		}
		return result;
	}

	debounced.clear = function() {
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
	};

	debounced.flush = function() {
		if (timeout) {
			result = func.apply(context, args);
			context = args = null;

			clearTimeout(timeout);
			timeout = null;
		}
	};

	return debounced;
};
