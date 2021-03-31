/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import express from 'express';
import fetch from 'node-fetch';
import base64url from 'base64url';

import {
  generateAttestationOptions,
  verifyAttestationResponse,
  generateAssertionOptions,
  verifyAssertionResponse,
  MetadataService,
} from '@simplewebauthn-alt/server';
import {
  AssertionCredentialJSON,
  AttestationCredentialJSON,
} from '@simplewebauthn-alt/typescript-types';
import { MetadataStatement } from '@simplewebauthn-alt/server/dist/metadata/metadataService';

import { rpID, expectedOrigin } from './index';
import { LoggedInUser } from './example-server';

interface LoggedInFIDOUser extends LoggedInUser {
  currentAssertionUserVerification?: UserVerificationRequirement;
}

/**
 * Create paths specifically for testing with the FIDO Conformance Tools
 */
export const fidoConformanceRouter = express.Router();
export const fidoRouteSuffix = '/fido';

const rpName = 'FIDO Conformance Test';

/**
 * Load JSON metadata statements provided by the Conformance Tools
 *
 * FIDO2 > TESTS CONFIGURATION > DOWNLOAD SERVER METADATA (button)
 */
const statements: MetadataStatement[] = [];

try {
  // Update this to whatever folder you extracted the statements to
  const conformanceMetadataPath = './fido-conformance-mds';
  const conformanceMetadataFilenames = fs.readdirSync(conformanceMetadataPath);
  for (const statementPath of conformanceMetadataFilenames) {
    if (statementPath.endsWith('.json')) {
      const contents = fs.readFileSync(`${conformanceMetadataPath}/${statementPath}`, 'utf-8');
      statements.push(JSON.parse(contents));
    }
  }
} catch (err) {
  // pass
}

/**
 * Initialize MetadataService with Conformance Testing-specific statements.
 */
fetch('https://mds.certinfra.fidoalliance.org/getEndpoints', {
  method: 'POST',
  body: JSON.stringify({ endpoint: `${expectedOrigin}${fidoRouteSuffix}` }),
  headers: { 'Content-Type': 'application/json' },
})
  .then(resp => resp.json())
  .then(json => {
    const routes = json.result;
    const mdsServers = routes.map((url: string) => ({
      url,
      rootCertURL: 'https://mds.certinfra.fidoalliance.org/pki/MDSROOT.crt',
      metadataURLSuffix: '',
    }));

    MetadataService.initialize({
      statements,
      mdsServers,
    });
  })
  .finally(() => {
    if (statements.length) {
      console.log(`ℹ️  Initializing metadata service with ${statements.length} local statements`);
    }

    console.log('🔐 FIDO Conformance routes ready');
  });

const inMemoryUserDeviceDB: { [username: string]: LoggedInFIDOUser } = {
  // [username]: string: {
  //   id: loggedInUserId,
  //   username: 'user@yourdomain.com',
  //   devices: [
  //     /**
  //      * {
  //      *   credentialID: string,
  //      *   publicKey: string,
  //      *   counter: number,
  //      * }
  //      */
  //   ],
  //   currentChallenge: undefined,
  //   currentAssertionUserVerification: undefined,
  // },
};
// A cheap way of remembering who's "logged in" between the request for options and the response
let loggedInUsername: string | undefined = undefined;

/**
 * [FIDO2] Server Tests > MakeCredential Request
 */
fidoConformanceRouter.post('/attestation/options', (req, res) => {
  const { body } = req;
  const { username, displayName, authenticatorSelection, attestation, extensions } = body;

  loggedInUsername = username;

  let user = inMemoryUserDeviceDB[username];
  if (!user) {
    const newUser = {
      id: username,
      username,
      devices: [],
    };

    inMemoryUserDeviceDB[username] = newUser;
    user = newUser;
  }

  const { devices } = user;

  const opts = generateAttestationOptions({
    rpName,
    rpID,
    userID: username,
    userName: username,
    userDisplayName: displayName,
    attestationType: attestation,
    authenticatorSelection,
    extensions,
    excludeCredentials: devices.map(dev => ({
      id: dev.credentialID,
      type: 'public-key',
      transports: ['usb', 'ble', 'nfc', 'internal'],
    })),
  });

  user.currentChallenge = opts.challenge;

  return res.send({
    ...opts,
    status: 'ok',
    errorMessage: '',
  });
});

/**
 * [FIDO2] Server Tests > MakeCredential Response
 */
fidoConformanceRouter.post('/attestation/result', async (req, res) => {
  const body: AttestationCredentialJSON = req.body;

  const user = inMemoryUserDeviceDB[`${loggedInUsername}`];

  const expectedChallenge = user.currentChallenge;

  let verification;
  try {
    verification = await verifyAttestationResponse({
      credential: body,
      expectedChallenge: `${expectedChallenge}`,
      expectedOrigin,
    });
  } catch (error) {
    console.error(`RP - attestation: ${error.message}`);
    return res.status(400).send({ errorMessage: error.message });
  }

  const { verified, attestationInfo } = verification;

  if (verified && attestationInfo) {
    const { credentialPublicKey, credentialID, counter } = attestationInfo;

    const existingDevice = user.devices.find(device => device.credentialID === credentialID);

    if (!existingDevice) {
      /**
       * Add the returned device to the user's list of devices
       */
      user.devices.push({
        credentialPublicKey,
        credentialID,
        counter,
      });
    }
  }

  return res.send({
    status: verified ? 'ok' : '',
    errorMessage: '',
  });
});

/**
 * [FIDO2] Server Tests > GetAssertion Request
 */
fidoConformanceRouter.post('/assertion/options', (req, res) => {
  const { body } = req;
  const { username, userVerification, extensions } = body;

  loggedInUsername = username;

  const user = inMemoryUserDeviceDB[username];

  const { devices } = user;

  const opts = generateAssertionOptions({
    extensions,
    userVerification,
    allowCredentials: devices.map(dev => ({
      id: dev.credentialID,
      type: 'public-key',
      transports: ['usb', 'ble', 'nfc', 'internal'],
    })),
  });

  user.currentChallenge = opts.challenge;
  user.currentAssertionUserVerification = userVerification;

  return res.send({
    ...opts,
    status: 'ok',
    errorMessage: '',
  });
});

fidoConformanceRouter.post('/assertion/result', (req, res) => {
  const body: AssertionCredentialJSON = req.body;
  const { id } = body;

  const user = inMemoryUserDeviceDB[`${loggedInUsername}`];

  // Pull up values specified when generation assertion options
  const expectedChallenge = user.currentChallenge;
  const userVerification = user.currentAssertionUserVerification;

  const credIDBuffer = base64url.toBuffer(id);
  const existingDevice = user.devices.find(device => device.credentialID.equals(credIDBuffer));

  if (!existingDevice) {
    throw new Error(`Could not find device matching ${id}`);
  }

  let verification;
  try {
    verification = verifyAssertionResponse({
      credential: body,
      expectedChallenge: `${expectedChallenge}`,
      expectedOrigin,
      expectedRPID: rpID,
      authenticator: existingDevice,
      fidoUserVerification: userVerification,
    });
  } catch (error) {
    console.error(`RP - assertion: ${error.message}`);
    return res.status(400).send({ errorMessage: error.message });
  }

  const { verified, assertionInfo } = verification;

  if (verified) {
    existingDevice.counter = assertionInfo.newCounter;
  }

  return res.send({
    status: verified ? 'ok' : '',
    errorMessage: '',
  });
});

/**
 * A catch-all for future test routes we might need to support but haven't yet defined (helps with
 * discovering which routes, what methods, and what data need to be defined)
 */
fidoConformanceRouter.all('*', (req, res, next) => {
  console.log(req.url);
  console.log(req.method);
  console.log(req.body);

  next();
});
