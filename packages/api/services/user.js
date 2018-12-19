exports = module.exports = function(opt) {
	return {
		name: 'user'
	};
};


function QueryUser(data) {
	var Block = All.api.Block;
	var q = Block.query().alias('user').select()
	.first().throwIfNotFound().where('user.type', 'user');
	if (!data.id && !data.email) throw new HttpError.BadRequest("Missing id or email");
	if (data.id) {
		q.where('user.id', data.id);
		delete data.id;
	} else if (data.email) {
		q.whereJsonText('user.data:email', 'in', data.email);
		delete data.email;
	}
	return q;
}

exports.get = function(data) {
	return QueryUser(data);
};
exports.get.schema = {
	$action: 'read',
	anyOf: [{
		required: ['email']
	}, {
		required: ['id']
	}],
	properties: {
		id: {
			type: 'string',
			minLength: 1,
			format: 'id'
		},
		email: {
			title: 'User email',
			type: 'array',
			items: {
				type: 'string',
				format: 'email',
				transform: ['trim', 'toLowerCase']
			}
		}
	}
};

exports.add = function(data) {
	return All.api.transaction(function(trx) {
		return QueryUser({
			email: [data.email]
		}).transacting(trx).then(function(user) {
			return user;
		}).catch(function(err) {
			if (err.status != 404) throw err;
			return All.api.Block.query(trx).insert({
				data: { email: data.email },
				type: 'user'
			}).returning('id');
		});
	});
};
exports.add.schema = {
	$action: 'add',
	required: ['email'],
	properties: {
		email: {
			type: 'string',
			format: 'email',
			transform: ['trim', 'toLowerCase']
		}
	}
};

exports.save = function(data) {
	return QueryUser(data).patchObject(data);
};

exports.del = function(data) {
	return QueryUser(data).del();
};
Object.defineProperty(exports.del, 'schema', {
	get: function() {
		var schema = Object.assign({}, exports.get.schema);
		schema.$action = 'del';
		return schema;
	}
});
