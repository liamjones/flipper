/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {checkXcodeVersionMismatch, IOSDeviceManager} from '../iOSDeviceManager';
// eslint-disable-next-line node/no-extraneous-import
import {getRenderHostInstance} from 'flipper-ui-core';
import {
  getFlipperServerConfig,
  setFlipperServerConfig,
} from '../../../FlipperServerConfig';
import {IOSDeviceParams} from 'flipper-common';

let fakeSimctlBridge: any;
let fakeIDBBridge: any;
let fakeFlipperServer: any;
const fakeDevices: IOSDeviceParams[] = [
  {
    udid: 'luke',
    type: 'emulator',
    name: 'Luke',
  },
  {
    udid: 'yoda',
    type: 'emulator',
    name: 'Yoda',
  },
];
const fakeExistingDevices = [
  {
    info: {os: 'iOS'},
    serial: 'luke',
  },
  {
    info: {os: 'Android'},
    serial: 'yoda',
  },
  {
    info: {os: 'iOS'},
    serial: 'plapatine',
  },
];

beforeEach(() => {
  fakeSimctlBridge = {
    getActiveDevices: jest.fn().mockImplementation(async () => fakeDevices),
  };
  fakeIDBBridge = {
    getActiveDevices: jest.fn().mockImplementation(async () => fakeDevices),
  };
  fakeFlipperServer = {
    getDevices: jest.fn().mockImplementation(() => fakeExistingDevices),
    registerDevice: jest.fn(),
    unregisterDevice: jest.fn(),
  };
  setFlipperServerConfig(getRenderHostInstance().serverConfig);
});

afterEach(() => {
  setFlipperServerConfig(undefined);
});

test('test checkXcodeVersionMismatch with correct Simulator.app', () => {
  const invalidVersion = checkXcodeVersionMismatch(
    [
      '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
    ],
    '/Applications/Xcode.app/Contents/Developer',
  );
  expect(invalidVersion).toEqual(undefined);
});

test('test checkXcodeVersionMismatch with an incorrect Simulator.app', () => {
  const invalidVersion = checkXcodeVersionMismatch(
    [
      '/Applications/Xcode_Incorrect.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
    ],
    '/Applications/Xcode.app/Contents/Developer',
  );
  expect(invalidVersion).toEqual(
    '/Applications/Xcode_Incorrect.app/Contents/Developer',
  );
});

test('test queryDevices when simctl used', async () => {
  const ios = new IOSDeviceManager(
    fakeFlipperServer,
    getFlipperServerConfig().settings,
  );
  ios.simctlBridge = fakeSimctlBridge;

  await ios.queryDevices(fakeSimctlBridge);

  expect(fakeSimctlBridge.getActiveDevices).toBeCalledTimes(1);
  expect(fakeIDBBridge.getActiveDevices).toBeCalledTimes(0);

  expect(fakeFlipperServer.registerDevice).toBeCalledTimes(1);
  expect(fakeFlipperServer.registerDevice).toBeCalledWith(
    expect.objectContaining({
      serial: 'yoda',
    }),
  );

  expect(fakeFlipperServer.unregisterDevice).toBeCalledTimes(1);
  expect(fakeFlipperServer.unregisterDevice).toBeCalledWith('plapatine');
});

test('test queryDevices when idb used', async () => {
  const ios = new IOSDeviceManager(
    fakeFlipperServer,
    getFlipperServerConfig().settings,
  );
  ios.simctlBridge = fakeSimctlBridge;

  await ios.queryDevices(fakeIDBBridge);

  expect(fakeSimctlBridge.getActiveDevices).toBeCalledTimes(0);
  expect(fakeIDBBridge.getActiveDevices).toBeCalledTimes(1);

  expect(fakeFlipperServer.registerDevice).toBeCalledTimes(1);
  expect(fakeFlipperServer.registerDevice).toBeCalledWith(
    expect.objectContaining({
      serial: 'yoda',
    }),
  );

  expect(fakeFlipperServer.unregisterDevice).toBeCalledTimes(1);
  expect(fakeFlipperServer.unregisterDevice).toBeCalledWith('plapatine');
});
