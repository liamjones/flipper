/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {promisify} from 'util';
import fs from 'fs-extra';
import {
  openssl,
  isInstalled as opensslInstalled,
} from './openssl-wrapper-with-promises';
import path from 'path';
import tmp, {FileOptions} from 'tmp';
import {reportPlatformFailures} from 'flipper-common';
import os from 'os';
import {isTest} from 'flipper-common';

const tmpFile = promisify(tmp.file) as (
  options?: FileOptions,
) => Promise<string>;

const getFilePath = (fileName: string): string => {
  return path.resolve(os.homedir(), '.flipper', 'certs', fileName);
};

// Desktop file paths
export const caKey = getFilePath('ca.key');
export const caCert = getFilePath('ca.crt');
export const serverKey = getFilePath('server.key');
export const serverCsr = getFilePath('server.csr');
export const serverSrl = getFilePath('server.srl');
export const serverCert = getFilePath('server.crt');

// Device file paths
export const csrFileName = 'app.csr';
export const deviceCAcertFile = 'sonarCA.crt';
export const deviceClientCertFile = 'device.crt';

const caSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=SonarCA';
const serverSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=localhost';
const minCertExpiryWindowSeconds = 24 * 60 * 60;
const allowedAppNameRegex = /^[\w.-]+$/;

const logTag = 'certificateUtils';
/*
 * RFC2253 specifies the unamiguous x509 subject format.
 * However, even when specifying this, different openssl implementations
 * wrap it differently, e.g "subject=X" vs "subject= X".
 */
const x509SubjectCNRegex = /[=,]\s*CN=([^,]*)(,.*)?$/;

export type SecureServerConfig = {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  requestCert: boolean;
  rejectUnauthorized: boolean;
};

export const ensureOpenSSLIsAvailable = async (): Promise<void> => {
  if (!(await opensslInstalled())) {
    throw new Error(
      "It looks like you don't have OpenSSL installed. Please install it to continue.",
    );
  }
};

export const loadSecureServerConfig = async (): Promise<SecureServerConfig> => {
  await ensureOpenSSLIsAvailable();
  await certificateSetup();
  return {
    key: await fs.readFile(serverKey),
    cert: await fs.readFile(serverCert),
    ca: await fs.readFile(caCert),
    requestCert: true,
    rejectUnauthorized: true, // can be false if necessary as we don't strictly need to verify the client
  };
};

export const extractAppNameFromCSR = async (csr: string): Promise<string> => {
  const path = await writeToTempFile(csr);
  const subject = await openssl('req', {
    in: path,
    noout: true,
    subject: true,
    nameopt: true,
    RFC2253: false,
  });
  await fs.unlink(path);
  const matches = subject.trim().match(x509SubjectCNRegex);
  if (!matches || matches.length < 2) {
    throw new Error(`Cannot extract CN from ${subject}`);
  }
  const appName = matches[1];
  if (!appName.match(allowedAppNameRegex)) {
    throw new Error(
      `Disallowed app name in CSR: ${appName}. Only alphanumeric characters and '.' allowed.`,
    );
  }
  return appName;
};

export const generateClientCertificate = async (
  csr: string,
): Promise<string> => {
  console.debug('Creating new client cert', logTag);

  return writeToTempFile(csr).then((path) => {
    return openssl('x509', {
      req: true,
      in: path,
      CA: caCert,
      CAkey: caKey,
      CAcreateserial: true,
      CAserial: serverSrl,
    });
  });
};

export const getCACertificate = async (): Promise<string> => {
  return fs.readFile(caCert, 'utf-8');
};

const certificateSetup = async () => {
  if (isTest()) {
    throw new Error('Server certificates not available in test');
  } else {
    await reportPlatformFailures(
      ensureServerCertExists(),
      'ensureServerCertExists',
    );
  }
};

const ensureServerCertExists = async (): Promise<void> => {
  const allExist = await Promise.all([
    fs.pathExists(serverKey),
    fs.pathExists(serverCert),
    fs.pathExists(caCert),
  ]).then((exist) => exist.every(Boolean));
  if (!allExist) {
    return generateServerCertificate();
  }

  try {
    await checkCertIsValid(serverCert);
    await verifyServerCertWasIssuedByCA();
  } catch (e) {
    console.warn('Not all certs are valid, generating new ones', e);
    await generateServerCertificate();
  }
};

const generateServerCertificate = async (): Promise<void> => {
  await ensureCertificateAuthorityExists();
  console.warn('Creating new server cert', logTag);
  await openssl('genrsa', {out: serverKey, '2048': false});
  await openssl('req', {
    new: true,
    key: serverKey,
    out: serverCsr,
    subj: serverSubject,
  });
  await openssl('x509', {
    req: true,
    in: serverCsr,
    CA: caCert,
    CAkey: caKey,
    CAcreateserial: true,
    CAserial: serverSrl,
    out: serverCert,
  });
};

const ensureCertificateAuthorityExists = async (): Promise<void> => {
  if (!(await fs.pathExists(caKey))) {
    return generateCertificateAuthority();
  }
  return checkCertIsValid(caCert).catch(() => generateCertificateAuthority());
};

const generateCertificateAuthority = async (): Promise<void> => {
  if (!(await fs.pathExists(getFilePath('')))) {
    await fs.mkdir(getFilePath(''));
  }
  console.log('Generating new CA', logTag);
  await openssl('genrsa', {out: caKey, '2048': false});
  await openssl('req', {
    new: true,
    x509: true,
    subj: caSubject,
    key: caKey,
    out: caCert,
  });
};

const checkCertIsValid = async (filename: string): Promise<void> => {
  if (!(await fs.pathExists(filename))) {
    throw new Error(`${filename} does not exist`);
  }
  // openssl checkend is a nice feature but it only checks for certificates
  // expiring in the future, not those that have already expired.
  // So we need a separate check for certificates that have already expired
  // but since this involves parsing date outputs from openssl, which is less
  // reliable, keeping both checks for safety.
  try {
    await openssl('x509', {
      checkend: minCertExpiryWindowSeconds,
      in: filename,
    });
  } catch (e) {
    console.warn(`Checking if certificate expire soon: ${filename}`, logTag, e);
    const endDateOutput = await openssl('x509', {
      enddate: true,
      in: filename,
      noout: true,
    });
    const dateString = endDateOutput.trim().split('=')[1].trim();
    const expiryDate = Date.parse(dateString);
    if (isNaN(expiryDate)) {
      console.error(
        'Unable to parse certificate expiry date: ' + endDateOutput,
      );
      throw new Error(
        'Cannot parse certificate expiry date. Assuming it has expired.',
      );
    }
    if (expiryDate <= Date.now() + minCertExpiryWindowSeconds * 1000) {
      throw new Error('Certificate has expired or will expire soon.');
    }
  }
};

const verifyServerCertWasIssuedByCA = async () => {
  const options: {
    [key: string]: any;
  } = {CAfile: caCert};
  options[serverCert] = false;
  const output = await openssl('verify', options);
  const verified = output.match(/[^:]+: OK/);
  if (!verified) {
    // This should never happen, but if it does, we need to notice so we can
    // generate a valid one, or no clients will trust our server.
    throw new Error('Current server cert was not issued by current CA');
  }
};

const writeToTempFile = async (content: string): Promise<string> => {
  const path = await tmpFile();
  await fs.writeFile(path, content);
  return path;
};
