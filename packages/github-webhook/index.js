var crypto = require('crypto');

exports = module.exports = function(opt) {
	return {
		name: 'api',
		service: init
	};
};

function init(All) {
	var opt = All.opt;
	console.info("Setting up /.api/github webhook");
	All.app.post('/.api/github', function(req, res, next) {
		var site = req.site;
		var save = false;
		Promise.resolve().then(function() {
			var event = req.get('X-Github-Event');
			if (event == "ping") {
				return res.sendStatus(200);
			}
			if (event != "push") {
				return next(new HttpError.BadRequest("Unsupported event"));
			}

			// TODO queue installations, and do db transaction
			var sign = req.get('X-Github-Signature');
			var delivery = req.get('X-Github-Delivery');
			if (sign && sign != signBlob(site.data['github-webhook-secret'] || '', req.body)) {
				throw new HttpError.Forbidden("Invalid Signature");
			}
			var payload = req.body;
			var fullName = payload.repository.full_name;
			var module = site.data.module;
			if (module && module.startsWith(fullName) &&
				(module.length == fullName.length || module[fullName.length] == "#")
			) {
					site.data.module = fullName + '#' + payload.after;
					save = true;
			}
			res.sendStatus(200);
		}).catch(next).then(function() {
			if (save) return All.site.save(site).catch(function(err) {
				console.error("site.save failure", site.data, err);
			});
		});
	});
}

function signBlob(key, blob) {
	return 'sha1=' + crypto.createHmac('sha1', key).update(blob).digest('hex');
}

