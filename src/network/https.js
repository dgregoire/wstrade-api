import cloudscraper from 'cloudscraper';
import customHeaders from '../headers';
import endpoints from '../api/endpoints';
import { configEnabled } from '../config';
import Tokens from '../core/tokens';

const [HTTP_OK, HTTP_CREATED] = [200, 201];

/*
 * Complete the URL by filling the parameter placeholders with the
 * data arguments.
 */
function finalizeRequest(endpoint, data) {
  // Make a copy so we don't modify the original one.
  const params = { ...data };
  let { url } = endpoint;

  // No need to do anything if the URL is static (no parameters)
  if (endpoint.parameters) {
    // Swap all the parameter placeholders with the arguments.
    for (let index = 0; index < Object.keys(endpoint.parameters).length; index++) {
      const parameterName = endpoint.parameters[index];

      // we have to explicitly check for null and undefined since parameter
      // values might be 0.
      if (params[parameterName] === null || params[parameterName] === undefined) {
        throw new Error(`URL parameter '${parameterName}' missing!`);
      }

      /*
        * Parameters surrounded with curly braces (e.g., {2}) are simple value replacements,
        * while ones surrounded with square brackets (e.g., [1]) are array-value replacements.
        */
      if (url.indexOf(`{${index}}`) >= 0) {
        url = url.replace(`{${index}}`, params[endpoint.parameters[index]]);
      } else if (url.indexOf(`[${index}]`) >= 0) {
        // extract query parameter name and the array of values
        const queryParamName = endpoint.parameters[index];
        const values = params[queryParamName];

        // Construct the queryParam using every value in the values array.
        // Here is an example of what queryParam ends up being:
        //
        // queryParamName = 'type'
        // values = ['buy', 'sell', 'dividend']
        // queryParam = 'type=buy&type=sell&type=dividend'
        const queryParam = values.map((value) => `${queryParamName}=${value}`).join('&');

        url = url.replace(`[${index}]`, queryParam);
      } else {
        throw new Error('Malformed URL! This is an internal error: raise an issue!');
      }

      // Must remove this key from the payload as it has been consumed by the URL
      delete params[endpoint.parameters[index]];
    }
  }

  // No payload attached to GET/DELETE requests
  if (['GET', 'HEAD'].includes(endpoint.method)) {
    return { url, payload: undefined };
  }

  return { url, payload: JSON.stringify(params) };
}

class HttpsWorker {
  /**
   * Create a new HttpsWorker with its own authentication state.
   */
  constructor() {
    this.tokens = new Tokens();
  }

  /*
   * Implements the network level protocol for talking to the
   * Wealthsimple Trade HTTPS API.
   */
  async talk(endpoint, data) {
    const headers = { 'Content-type': 'application/json' };

    if (endpoint.authenticated) {
      // no access token means we will prematurely fail the request because
      // this is a privileged endpoint.
      if (!this.tokens.access) {
        throw new Error(`Authentication required for '${endpoint.url}'`);
      }

      if (configEnabled('implicit_token_refresh')) {
        await this.implicitTokenRefresh();
      }

      headers.Authorization = this.tokens.access;
    }

    // Apply all custom headers
    customHeaders.values().forEach(([key, value]) => { headers[key] = value; });

    // fill path and query parameters in the URL
    const { url, payload } = finalizeRequest(endpoint, data);

    // Wealthsimple endpoints are protected by Cloudflare.
    // The cloudscraper library takes care of the Cloudflare challenges
    // while also executing our request
    let response = null;
    await cloudscraper({
      url,
      body: payload,
      method: endpoint.method,
      headers,
      callback: (unused, res) => {
        // Save the HTTP response
        response = res;
      },
    }).catch(() => { });

    try {
      response.body = JSON.parse(response.body);
    } catch (error) {
      // it's not JSON, but that's fine. We don't do anything
      // for now.
    }

    return response;
  }

  /*
   * Fulfill the endpoint request given the endpoint configuration, optional
   * data.
   */
  async handleRequest(endpoint, data) {
    // Submit the HTTP request to the Wealthsimple Trade Servers
    const response = await this.talk(endpoint, data);

    if ([HTTP_OK, HTTP_CREATED].includes(response.statusCode)) {
      return endpoint.onSuccess(response);
    }

    return Promise.reject(await endpoint.onFailure(response));
  }

  /**
   * Obtain a new set of authentication tokens using the
   * existing refresh token.
   */
  async refreshAuthentication() {
    const response = await this.handleRequest(endpoints.REFRESH, {
      refresh_token: this.tokens.refresh,
    });

    this.tokens.store(response.tokens);
  }

  /**
   * Check if the existing set of tokens have expired, automatically
   * triggering a refresh if they have expired.
   */
  async implicitTokenRefresh() {
    if (this.tokens.expired()) {
      if (this.tokens.refresh) {
        try {
          // Let's implicitly refresh the access token using the refresh token.
          await this.refreshAuthentication();
        } catch (error) {
          // The refresh token is not valid.
          throw new Error(`Unable to refresh expired token: ${error}`);
        }
      } else {
        // We are forced to reject as our access token has expired and we
        // do not have a refresh token.
        throw new Error('Access token expired');
      }
    }
  }
}

export default HttpsWorker;
