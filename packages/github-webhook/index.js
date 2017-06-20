var bodyParser = require('body-parser');
var crypto = require('crypto');

exports = module.exports = function(opt) {
	return {
		name: 'api',
		service: init
	};
};

function init(All) {
	var opt = All.opt;
	All.app.post('/.api/github', bodyParser.raw({
		type: "json"
	}), function(req, res, next) {
		var event = req.get('X-Github-Event');
		if (event == "ping") {
			return res.sendStatus(200);
		}
		if (event != "push") {
			return next(new HttpError.BadRequest("Unsupported event"));
		}
		var domain = req.hostname;

		All.api.site.get({domain: req.hostname}).then(function(site) {
			if (!site) throw new HttpError.NotFound("Site not found");
			var sign = req.get('X-Github-Signature');
			var delivery = req.get('X-Github-Delivery');
			if (sign && sign != signBlob(site.data['github-webhook-secret'] || '', req.body)) {
				throw new HttpError.Forbidden("Invalid Signature");
			}
			var payload = JSON.parse(req.body);
			var fullName = payload.repository.full_name;
			var save = false;
			Object.keys(site.data.dependencies || {}).forEach(function(name) {
				var spec = site.data.dependencies[name];
				if (spec.startsWith(fullName) &&
				(spec.length == fullName.length || spec[fullName.length] == "#")
				) {
					site.data.dependencies[name] = fullName + '#' + payload.after;
					save = true;
				}
			});
			if (save) return All.api.site.save(site).then(function(result) {
				console.info(result);
				res.sendStatus(200);
			});
			else res.sendStatus(200);
		}).catch(next);
	});
}

function signBlob(key, blob) {
	return 'sha1=' + crypto.createHmac('sha1', key).update(blob).digest('hex');
}

