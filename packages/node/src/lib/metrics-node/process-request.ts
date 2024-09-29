import type { ExtendedIncomingMessage } from './log';
import type { LogOptions } from '../shared/options';
import type { Cookie, Param, PostData, Request } from 'har-format';

import * as qs from 'querystring';
import url, { URL } from 'url';

import * as contentType from 'content-type';

import { mask } from '../shared/mask';
import { objectToArray, searchToArray } from '../shared/object-to-array';
import {
  fixHeader,
  redactProperties,
  redactOtherProperties,
  parseRequestBody,
  isApplicationJson,
} from '../shared/processing-helpers';

import { getProto } from './construct-payload';

/**
 * This transforms the IncommingMessage and additional provided information into the relevant HAR structure
 *
 * @param req The IncommingMessage from the node server.
 * @param requestBody A parsed request body object, or an unparsed request body string.
 * @param options A collection of processing options.
 *
 * @returns The proper request structure following the HAR format
 */
export default function processRequest(
  req: ExtendedIncomingMessage,
  requestBody?: Record<string, unknown> | string,
  options?: LogOptions,
): Request {
  const protocol = fixHeader(req.headers['x-forwarded-proto'] || '')?.toLowerCase() || getProto(req);
  const host = fixHeader(req.headers['x-forwarded-host'] || '') || req.headers.host;

  const denylist = options?.denylist || options?.blacklist;
  const allowlist = options?.allowlist || options?.whitelist;

  let mimeType = '';
  try {
    mimeType = contentType.parse(req.headers['content-type'] || '').type;
  } catch (e) {} // eslint-disable-line no-empty

  let reqBody = typeof requestBody === 'string' ? parseRequestBody(requestBody, mimeType) : requestBody;
  let postData: PostData | undefined;

  if (denylist) {
    reqBody = typeof reqBody === 'object' ? redactProperties(reqBody, denylist) : reqBody;
    req.headers = redactProperties(req.headers, denylist);
  }

  if (allowlist && !denylist) {
    reqBody = typeof reqBody === 'object' ? redactOtherProperties(reqBody, allowlist) : reqBody;
    req.headers = redactOtherProperties(req.headers, allowlist);
  }

  if (mimeType === 'application/x-www-form-urlencoded') {
    postData = {
      mimeType,
      // `reqBody` is likely to be an object, but can be empty if no HTTP body sent
      params: objectToArray((reqBody || {}) as Record<string, unknown>) as Param[],
    };
  } else if (isApplicationJson(mimeType)) {
    postData = {
      mimeType,
      text: typeof reqBody === 'object' || Array.isArray(reqBody) ? JSON.stringify(reqBody) : reqBody || '',
    };
  } else if (mimeType) {
    let stringBody = '';

    try {
      stringBody = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    } catch (e) {
      stringBody = '[ReadMe is unable to handle circular JSON. Please contact support if you have any questions.]';
    }

    postData = {
      mimeType,
      // Do our best to record *some sort of body* even if it's not 100% accurate.
      text: stringBody,
    };
  }

  // We use a fake host here because we rely on the host header which could be redacted.
  // We only ever use this reqUrl with the fake hostname for the pathname and querystring.
  // req.originalUrl is express specific, req.url is node.js
  const reqUrl = new URL(req.originalUrl || req.url || '', 'https://readme.io');

  if (req.headers.authorization) {
    req.headers.authorization = mask(req.headers.authorization);
  }

  const requestData: Request = {
    method: req.method || '',
    url: url.format({
      // Handle cases where some reverse proxies put two protocols into x-forwarded-proto
      // This line does the following: "https,http" -> "https"
      // https://github.com/readmeio/metrics-sdks/issues/378
      protocol: protocol.split(',')[0],
      host,
      pathname: reqUrl.pathname,
      // Search includes the leading questionmark, format assumes there isn't one, so we trim that off.
      query: qs.parse(reqUrl.search.substring(1)),
    }),
    httpVersion: `${getProto(req).toUpperCase()}/${req.httpVersion}`,
    headers: objectToArray(req.headers, { castToString: true }),
    queryString: searchToArray(reqUrl.searchParams),
    postData,
    // TODO: When readme starts accepting these, send the correct values
    cookies: [] satisfies Cookie[],
    headersSize: -1,
    bodySize: -1,
  } as const;

  if (typeof requestData.postData === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { postData: postDataToBeOmitted, ...remainingRequestData } = requestData;
    return remainingRequestData;
  }

  return requestData;
}