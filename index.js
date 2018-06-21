const request = require('r2');
const uuid = require('node-uuid');
const jwt = require('jsonwebtoken');
const config = require('./config');

const constructPayload = require('./lib/construct-payload');
const getReadmeData = require('./lib/get-readme-data');

// We're doing this to buffer up the response body
// so we can send it off to the metrics server
// It's unfortunate that this isn't accessible
// natively. This may take up lots of memory on
// big responses, we can make it configurable in future
function patchResponse(res) {
  /* eslint-disable no-underscore-dangle */
  const { write, end } = res;

  res._body = '';

  res.write = (chunk, encoding, cb) => {
    res._body += chunk;
    write.call(res, chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
    // Chunk is optional in res.end
    // http://nodejs.org/dist/latest/docs/api/http.html#http_response_end_data_encoding_callback
    if (chunk) res._body += chunk;
    end.call(res, chunk, encoding, cb);
  };
}

module.exports.metrics = (apiKey, group, options = {}) => {
  if (!apiKey) throw new Error('You must provide your ReadMe API key');
  if (!group) throw new Error('You must provide a grouping function');

  const bufferLength = options.bufferLength || config.bufferLength;
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  let queue = [];

  return (req, res, next) => {
    const startedDateTime = new Date();
    patchResponse(res);

    function send() {
      // This should in future become more sophisticated,
      // with flush timeouts and more error checking but
      // this is fine for now
      queue.push(constructPayload(req, res, group, options, { startedDateTime }));
      if (queue.length >= bufferLength) {
        request
          .post(`${config.host}/request`, {
            headers: { authorization: `Basic ${encoded}` },
            json: queue,
          })
          .response.then(() => {
            queue = [];
          });
      }

      cleanup(); // eslint-disable-line no-use-before-define
    }

    function cleanup() {
      res.removeListener('finish', send);
      res.removeListener('error', cleanup);
      res.removeListener('close', cleanup);
    }

    // Add response listeners
    res.once('finish', send);
    res.once('error', cleanup);
    res.once('close', cleanup);

    return next();
  };
};

module.exports.login = (apiKey, userFnc, options = {}) => {
  if (!apiKey) throw new Error('You must provide your ReadMe API key');
  if (!userFnc) throw new Error('You must provide a function to get the user');
  return async (req, res) => {
    let u;
    try {
      u = userFnc(req);
    } catch (e) {
      // User isn't logged in
    }

    if (!u) {
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      return res.redirect(`${options.loginUrl}?redirect=${encodeURIComponent(fullUrl)}`);
    }

    const jwtUrl = await module.exports.magicLink(apiKey, u, req.query.redirect);
    return res.redirect(jwtUrl);
  };
};

module.exports.magicLink = async (apiKey, user, redirectPath = '') => {
  if (!apiKey) throw new Error('You must provide your ReadMe API key');
  if (!user) throw new Error('You must provide a user object');

  const readmeData = await getReadmeData(apiKey);
  let baseUrl = redirectPath;

  if (!redirectPath.startsWith('http')) {
    baseUrl = `${readmeData.baseUrl}${redirectPath}`;
  }

  const jwtOptions = {
    jwtid: uuid.v4(),
  };

  const token = jwt.sign(user, readmeData.jwtSecret, jwtOptions);
  return `${baseUrl}?auth_token=${token}`;
};
