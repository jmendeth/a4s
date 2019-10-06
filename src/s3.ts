/**
 * This module contains signing logic that is specific for the S3
 * service, see [[signS3Request]].
 *
 * Additionally there's POST form parameter authentication,
 * which is designed mainly to allow users to upload files
 * to S3 directly from their browser. See [[signS3Policy]].
 */
/** */

import { URLSearchParams, URL } from 'url'

import { formatTimestamp, getSigning, signString, ALGORITHM,
    RelaxedCredentials, GetSigningData, SignOptions } from './core'
import { signRequest, SignHTTPOptions, CanonicalOptions, SignedRequest } from './http'
import { DEFAULT_REGION } from './util/endpoint'

export interface PolicySignOptions {
    timestamp?: string | Date
    getSigningData?: GetSigningData
}

export interface SignedS3Request extends SignedRequest {
    /** If set to true, the hash will be set to true */
    unsigned?: boolean
}

/** Maximum value for the X-Amz-Expires query parameter */
export const EXPIRES_MAX = 604800

/** Option defaults for the S3 service */
export const S3_OPTIONS = {
    dontNormalize: true,
    onlyEncodeOnce: true,
    setContentHash: true,
}

/** Special value for payload digest, which indicates the payload is not signed */
export const PAYLOAD_UNSIGNED = 'UNSIGNED-PAYLOAD'

function patchURL(
    request: SignedS3Request,
    extra: {[key: string]: string},
    url: { host?: string, pathname?: string, searchParams?: URLSearchParams },
    set?: boolean
) {
    if (set || request.url !== url) {
        if (!url.searchParams) {
            url.searchParams = new URLSearchParams()
        }
    } else {
        const { host, pathname, searchParams } = url
        url = { host, pathname, searchParams: new URLSearchParams(searchParams) }
    }
    Object.keys(extra).forEach(k => url.searchParams!.set(k, extra[k]))
    return url
}

/**
 * High-level function that signs an HTTP request for S3 using
 * `AWS-HMAC-SHA256` with either headers (`Authorization`) or query
 * parameters (presigned URL) depending on the `query` option.
 * 
 * This is a special version of [[signRequest]] that implements
 * some quirks needed for S3:
 *
 *  - You can set `unsigned` in the request to leave payload unsigned
 *    (body hash is set to `UNSIGNED_PAYLOAD`). For query authorization
 *    it's on by default (S3 query authorization can't sign the body).
 *
 *  - For query authorization, the `X-Amz-Expires` parameter is
 *    set to `EXPIRES_MAX` if not present.
 *
 *  - `S3_OPTIONS` are applied by default (disables normalization
 *    and double encoding when calculating signature, adds
 *    `x-amz-content-sha256` for header authorization). Also,
 *    `serviceName` defaults to `s3` if host was not passed.
 *
 * The extra parameters are returned with the others, and also
 * set if requested.
 * 
 * @param credentials Credentials to sign the request with
 * @param request HTTP request to sign, see [[SignedS3Request]]
 * @param options Other options
 * @returns Authorization headers / query parameters
 */
export function signS3Request(
   credentials: RelaxedCredentials,
   request: SignedS3Request,
   options?: SignHTTPOptions & CanonicalOptions & SignOptions
): {[key: string]: string} {
    const isQuery = options && options.query
    let { url, body, unsigned } = { unsigned: isQuery, ...request }
    url = typeof url === 'string' ? new URL(url) : url
    const originalRequest = request
    const extra: {[key: string]: string} = {}

    if (isQuery) {
        if (!(url.searchParams && url.searchParams.has('X-Amz-Expires'))) {
            extra['X-Amz-Expires'] = EXPIRES_MAX.toString()
            url = patchURL(request, extra, url, options && options.set)
        }
    } else if (options && options.set) {
        request.headers = request.headers || {}
    }
    body = unsigned ? { hash: PAYLOAD_UNSIGNED } : body
    request = { ...request, url, body }

    if (typeof request.url !== 'string' && !request.url.host) {
        credentials = { serviceName: 's3', ...credentials }
    }
    const result = { ...extra, ...signRequest(
        credentials, request, { ...S3_OPTIONS, ...options }) }
    if (options && options.set && isQuery &&
        typeof originalRequest.url === 'string') {
        originalRequest.url = (url as URL).toString()
    }
    if (typeof originalRequest.url !== 'string' && !originalRequest.url.host) {
        originalRequest.url.host = url.host
    }
    return result
}

/**
 * (POST form param based authentication)
 *
 * This method signs the passed policy and returns the
 * [authentication parameters][policy-auth] that you need to attach
 * to the [created form][create-form].
 *
 * See [this][construct-policy] for how to write the policy.
 * The policy shouldn't contain any authentication parameters (such
 * as `x-amz-date`); these will be added before signing it.
 *
 * > For a working example of use, see `demo_s3_post`.
 *
 * [create-form]: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTForms.html
 * [construct-policy]: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
 * [policy-auth]: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-authentication-HTTPPOST.html
 *
 * @param credentials The IAM credentials to use for signing
 *                   (service name defaults to 's3', and the default region)
 * @param policy The policy object
 * @param timestamp You can optionally provide the timestamp for signing,
 *                  otherwise it will be generated using [[formatTimestamp]]
 * @returns Key - value object containing the form parameters
 */
export function signS3Policy(
    credentials: RelaxedCredentials,
    policy: any,
    options?: PolicySignOptions
): {[key: string]: string} {
    const ts = options && options.timestamp
    const cr = { serviceName: 's3', regionName: DEFAULT_REGION, ...credentials }

    // Get timestamp, derive key, prepare form fields
    const timestamp = (typeof ts === 'string') ? ts : formatTimestamp(ts)
    const { signing, credential } = getSigning(timestamp, cr, options)
    const fields: {[key: string]: string} = {
        'x-amz-date': timestamp,
        'x-amz-algorithm': ALGORITHM,
        'x-amz-credential': credential,
    }

    // Add the fields to the policy conditions
    const conditions = (policy.conditions || []).concat(
        Object.keys(fields).map(k => ({ [k]: fields[k] })))
    const finalPolicy = JSON.stringify({ ...policy, conditions })

    // Encode and sign the policy
    const encodedPolicy = Buffer.from(finalPolicy).toString('base64')
    const signature = signString(signing.key, encodedPolicy).toString('hex')

    return { ...fields, 'policy': encodedPolicy, 'x-amz-signature': signature }
}

import * as chunked from './s3_chunked'
export { chunked }
