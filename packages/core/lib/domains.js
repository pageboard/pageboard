var DNS = {
	lookup: require('util').promisify(require('dns').lookup),
	reverse: require('util').promisify(require('dns').reverse)
};
var pageboardNames;
module.exports = Domains;

function Domains(All) {
	this.All = All;
	this.sites = {}; // cache sites by id
	this.hosts = {}; // cache hosts by hostname
	this.alts = {}; // alternative alt domains mapped to domains
	this.init = this.init.bind(this);
}

/*
maintain a cache (hosts) of requested hostnames
- each hostname is checked to resolve to pageboard current IP (which is resolved and cached,
so adding an IP to pageboard and pointing a host to that IP needs a restart)
- then each hostname, if it is a subdomain of pageboard, gives a site.id, or if not, a site.domain
- site instance is loaded and cached
- /.well-known/pageboard returns here
- site is installed and init() is holded by a hanging promise
- site installation calls upcache update url, which resolves the hanging promise
- init returns for everyone
*/
Domains.prototype.init = function(req, res, next) {
	var All = this.All;
	var self = this;
	var sites = this.sites;
	var hosts = this.hosts;
	var alts = this.alts;
	var hostname = req.hostname;
	var alt;
	if (alts[hostname]) {
		alt = hostname;
		hostname = alts[hostname];
	}
	var host = hosts[hostname];
	if (!host) {
		hosts[hostname] = host = {
			name: hostname
		};
	}
	if (!host.searching && !host._error) {
		delete host._error;
		host.isSearching = true;
		host.searching = Promise.resolve().then(function() {
			return this.check(host, req);
		}.bind(this)).then(function(hostname) {
			var site = host.id && sites[host.id];
			if (site) return site;
			var id;
			pageboardNames.some(function(hn) {
				if (hostname.endsWith(hn)) {
					id = hostname.substring(0, hostname.length - hn.length);
					return true;
				}
			});
			var data = {
				domain: host.name
			};
			if (id) data.id = id; // search by domain and id
			return All.site.get(data).select('_id');
		}).then(function(site) {
			if (site.id == "pageboard") throw new HttpError.NotFound("site cannot have id='pageboard'");
			host.id = site.id;
			sites[site.id] = site;
			if (!site.data) site.data = {};
			if (!site.hostname) site.hostname = host.name;
			if (site.data.domain && !hosts[site.data.domain]) {
				// alienate current hostname with official data.domain
				hosts[site.data.domain] = host;
				if (site.data.alt) {
					if (site.data.alt == host.name) {
						alt = site.data.alt;
						host.name = site.data.domain;
					}
					alts[site.data.alt] = site.data.domain;
				}
			}
			return site;
		}).catch(function(err) {
			host._error = err;
			if (host.finalize) host.finalize();
		}).finally(function() {
			host.isSearching = false;
		});
	}
	if (!host.installing && !host._error) {
		host.isInstalling = true;
		host.installing = host.searching.then(function(site) {
			if (host._error) return;
			site.href = host.href;
			site.hostname = host.name;
			// never throw an error since errors are already dealt with in install
			return All.install(site).catch(function() {});
		}).finally(function() {
			host.isInstalling = false;
		});
	}
	if (!host.waiting && !host._error) {
		doWait(host);
	}

	if (req.path == "/.well-known/upcache") {
		if (host.finalize) {
			host.finalize();
		}
		p = host.installing;
	} else if (req.path == "/.well-known/pageboard") {
		p = host.searching;
	} else if (req.path == "/favicon.ico" || req.path.startsWith('/.files/') || req.path.startsWith('/.api/')) {
		p = host.waiting;
	} else if (req.path == "/.well-known/status.html") {
		return next();
	} else if (req.path == "/.well-known/status.json") {
		p = host.waiting;
	} else if (host.isWaiting) {
		p = new Promise(function(resolve) {
			setTimeout(resolve, host.parked ? 0 : 2000);
		}).then(function() {
			if (host.isWaiting && !req.path.startsWith('/.')) {
				next = null;
				res.redirect(host.href +  "/.well-known/status.html?" + encodeURIComponent(req.url));
			} else {
				return host.waiting;
			}
		});
	} else {
		p = host.waiting;
	}
	return p.then(function() {
		if (!next) return;
		if (host._error) {
			next(host._error);
			return;
		}
		if (alt) {
			res.redirect(host.href +  req.url);
			return;
		}
		var site = self.sites[host.id];
		var errors = site.errors;
		if (req.url.startsWith('/.api/')) {
			// api needs a real site instance and be able to toy with it
			site = site.$clone();
		} else {
			// others don't
		}

		site.href = host.href;
		site.hostname = host.name;
		site.errors = errors;

		req.site = site;
		req.upgradable = host.upgradable;
		next();
	}).catch(next);
};

Domains.prototype.check = function(host, req) {
	var fam = 4;
	var localhost4 = "127.0.0.1";
	var localhost6 = "::1";
	var ip = req.get('X-Forwarded-By');
	if (ip) {
		if (isIPv6(ip)) fam = 6;
	} else {
		var address = req.socket.address();
		ip = address.address;
		if (!ip) {
			ip = localhost4;
		}
		fam = address.family == 'IPv6' ? 6 : 4;
	}
	var ips = {};
	ips['ip' + fam] = ip;
	var prefix = '::ffff:';
	if (fam == 6) {
		if (ip.startsWith(prefix)) {
			var tryFour = ip.substring(prefix.length);
			if (!isIPv6(tryFour)) ips.ip4 = tryFour;
		}
	}
	var local = false;
	if (ips.ip4 == localhost4) {
		local = true;
		if (!ips.ip6) ips.ip6 = localhost6;
	} else if (ips.ip6 == localhost6) {
		local = true;
		if (!ips.ip4) ips.ip4 = localhost4;
	}

	host.local = local;
	host.upgradable = req.get('Upgrade-Insecure-Requests') && !local;
	host.href = (host.upgradable ? 'https' : req.protocol) + '://' + req.get('Host');

	var hostname = host.name;

	return Promise.resolve().then(function() {
		if (!pageboardNames) {
			if (local) {
				if (hostname == "localhost") hostname += ".localdomain";
				var parts = hostname.split('.');
				parts[0] = "";
				pageboardNames = [parts.join('.')];
			} else {
				return DNS.reverse(ip).then(function(hostnames) {
					pageboardNames = hostnames.map(function(hn) {
						return '.' + hn;
					});
				});
			}
		}
	}).then(function() {
		if (host.local) return hostname;
		return DNS.lookup(hostname, {
			all: false
		}).then(function(lookup) {
			if (lookup.address == hostname) throw new Error("hostname is an ip " + hostname);
			var expected = ips['ip' + lookup.family];
			if (lookup.address != expected) {
				setTimeout(function() {
					// allow checking again in a minute
					if (host._error && host._error.statusCode == 503) delete host._error;
				}, 60000);
				throw new HttpError.ServiceUnavailable(`ip${lookup.family} ${lookup.address} does not match ${expected}`);
			}
			return hostname;
		});
	});
};

Domains.prototype.promote = function(site) {
	var cur = this.sites[site.id] || {};
	cur.errors = [];
	var href = site.href || cur.href;
	Object.defineProperty(site, 'href', {
		enumerable: false,
		configurable: true,
		writable: true,
		value: href
	});
	var hostname = site.hostname || cur.hostname || site.data.domain;
	Object.defineProperty(site, 'hostname', {
		enumerable: false,
		configurable: true,
		writable: true,
		value: hostname
	});
	Object.defineProperty(site, 'errors', {
		enumerable: false,
		configurable: true,
		writable: true,
		value: cur.errors
	});
};

Domains.prototype.replace = function(site) {
	var cur = this.sites[site.id];
	var oldDomain = cur && cur.data && cur.data.domain;
	var newDomain = site.data && site.data.domain;
	if (oldDomain != newDomain) {
		this.hosts[newDomain] = this.hosts[oldDomain] || this.hosts[site.hostname];
		if (oldDomain) delete this.hosts[oldDomain];
	}
	this.sites[site.id] = site;
};

Domains.prototype.hold = function(site) {
	if (site.data.env == "production" && site.$model) return; // do not hold
	var host = this.hosts[site.hostname];
	if (!host) return;
	doWait(host);
};

Domains.prototype.release = function(site) {
	var host = this.hosts[site.hostname];
	if (!host) return;
	host.isWaiting = false;
	delete host.parked;
};

Domains.prototype.error = function(site, err) {
	try {
		if (!site.hostname) console.warn("All.domains.error(site) missing site.hostname");
		var host = this.hosts[site.hostname];
		if (!host) {
			console.error("Error", site.id, err);
			return;
		}
		site.errors.push(errorObject(site, err));
		if (site.data.env == "production" && site.$model) {
			// do nothing
		} else {
			host.isWaiting = true;
			host.parked = true;
		}
		if (host.finalize) host.finalize();
	} catch(ex) {
		console.error(ex);
	}
};

function errorObject(site, err) {
	var std = err.toString();
	var stop = false;
	var errObj = {
		name: err.name,
		message: err.message
	};
	if (err.stack) errObj.stack = err.stack.split('\n').map(function(line) {
		if (line == std) return;
		var index = line.indexOf("/pageboard/");
		if (index >= 0) return line.substring(index);
		if (/^\s*at\s/.test(line)) return;
		return line;
	}).filter(x => !!x).join('\n');

	return errObj;
}

function isIPv6(ip) {
	return ip.indexOf(':') >= 0;
}

function doWait(host) {
	if (host.finalize) return;
	host.isWaiting = true;
	var subpending = new Promise(function(resolve) {
		host.finalize = function() {
			delete host.finalize;
			resolve();
		};
	});
	host.waiting = host.installing.then(function() {
		return subpending;
	});
}

