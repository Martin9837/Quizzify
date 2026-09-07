// body-parser reaches iconv-lite through raw-body, and iconv-lite's stream
// support does not load on workerd. Nothing in this app decodes a non-UTF-8
// request body -- the Durable Object bridge parses JSON itself -- so the
// module is aliased to a stub that fails loudly if anything ever does.
const unsupported = () => {
  throw new Error('iconv-lite is not available on Workers; decode UTF-8 directly');
};
export const encodingExists = () => false;
export const decode = unsupported;
export const encode = unsupported;
export const getDecoder = unsupported;
export const getEncoder = unsupported;
export const encodings = {};
export default { encodingExists, decode, encode, getDecoder, getEncoder, encodings };
