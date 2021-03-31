import type {
  AuthenticationExtensionsClientInputs,
  PublicKeyCredentialRequestOptionsJSON,
  PublicKeyCredentialDescriptor,
  UserVerificationRequirement,
} from '@simplewebauthn-alt/typescript-types';
import base64url from 'base64url';

import generateChallenge from '../helpers/generateChallenge';

export type GenerateAssertionOptionsOpts = {
  allowCredentials?: PublicKeyCredentialDescriptor[];
  challenge?: string | Buffer;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
  rpID?: string;
};

/**
 * Prepare a value to pass into navigator.credentials.get(...) for authenticator "login"
 *
 * @param allowCredentials Authenticators previously registered by the user, if any. If undefined
 * the client will ask the user which credential they want to use
 * @param challenge Random value the authenticator needs to sign and pass back
 * user for assertion
 * @param timeout How long (in ms) the user can take to complete assertion
 * @param userVerification Set to `'discouraged'` when asserting as part of a 2FA flow, otherwise
 * set to `'preferred'` or `'required'` as desired.
 * @param extensions Additional plugins the authenticator or browser should use during assertion
 * @param rpID Valid domain name (after `https://`)
 */
export default function generateAssertionOptions(
  options: GenerateAssertionOptionsOpts = {},
): PublicKeyCredentialRequestOptionsJSON {
  const {
    allowCredentials,
    challenge = generateChallenge(),
    timeout = 60000,
    userVerification,
    extensions,
    rpID,
  } = options;

  return {
    challenge: base64url.encode(challenge),
    allowCredentials: allowCredentials?.map(cred => ({
      ...cred,
      id: base64url.encode(cred.id as Buffer),
    })),
    timeout,
    userVerification,
    extensions,
    rpId: rpID,
  };
}
