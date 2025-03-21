/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {IncomingMessage} from 'http';
import ServerAdapter from './ServerAdapter';
import WebSocket, {
  AddressInfo,
  Server as WSServer,
  VerifyClientCallbackSync,
} from 'ws';
import {createServer as createHttpsServer} from 'https';
import {createServer as createHttpServer} from 'http';
import querystring from 'querystring';
import {ClientQuery} from 'flipper-common';
import {
  assertNotNull,
  parseClientQuery,
  parseMessageToJson,
  verifyClientQueryComesFromCertExchangeSupportedOS,
} from './Utilities';
import {SecureServerConfig} from '../utils/certificateUtils';
import {Server} from 'net';
import {serializeError} from 'serialize-error';
import {WSCloseCode} from '../utils/WSCloseCode';

export interface ConnectionCtx {
  clientQuery?: ClientQuery;
  ws: WebSocket;
  request: IncomingMessage;
}

// based on https://github.com/websockets/ws/blob/master/lib/websocket-server.js#L40,
// exposed to share with socket.io defaults
export const WEBSOCKET_MAX_MESSAGE_SIZE = 100 * 1024 * 1024;

/**
 * It serves as a base class for WebSocket based servers. It delegates the 'connection'
 * event to subclasses as a customisation point.
 */
class ServerWebSocket extends ServerAdapter {
  protected wsServer?: WSServer;
  private httpServer?: Server;

  async start(port: number, sslConfig?: SecureServerConfig): Promise<number> {
    const assignedPort = await new Promise<number>((resolve, reject) => {
      const server = sslConfig
        ? createHttpsServer(sslConfig)
        : createHttpServer();

      const wsServer = new WSServer({
        server,
        verifyClient: this.verifyClient(),
        maxPayload: WEBSOCKET_MAX_MESSAGE_SIZE,
      });

      // We do not need to listen to http server's `error` because it is propagated to WS
      // https://github.com/websockets/ws/blob/a3a22e4ed39c1a3be8e727e9c630dd440edc61dd/lib/websocket-server.js#L109
      const onConnectionError = (error: Error) => {
        reject(
          new Error(
            `Unable to start server at port ${port} due to ${JSON.stringify(
              serializeError(error),
            )}`,
          ),
        );
      };
      wsServer.once('error', onConnectionError);
      server.listen(port, () => {
        console.debug(
          `${sslConfig ? 'Secure' : 'Insecure'} server started on port ${port}`,
          'server',
        );

        // Unsubscribe connection error listener. We'll attach a permanent error listener later
        wsServer.off('error', onConnectionError);

        this.listener.onListening(port);
        this.wsServer = wsServer;
        this.httpServer = server;
        resolve((server.address() as AddressInfo).port);
      });
    });

    assertNotNull(this.wsServer);
    assertNotNull(this.httpServer);

    this.wsServer.on(
      'connection',
      (ws: WebSocket, request: IncomingMessage) => {
        ws.on('error', (error) => {
          console.error('[conn] WS connection error:', error);
          this.listener.onError(error);
        });

        try {
          this.onConnection(ws, request);
        } catch (error) {
          // If an exception is thrown, an `error` event is not emitted automatically.
          // We need to explicitly handle the error and emit an error manually.
          // If we leave it unhanled, the process just dies
          // https://replit.com/@aigoncharov/WS-error-handling#index.js
          ws.emit('error', error);
          // TODO: Investigate if we need to close the socket in the `error` listener
          // DRI: @aigoncharov
          ws.close(WSCloseCode.InternalError);
        }
      },
    );
    this.wsServer.on('error', (error) => {
      console.error('[conn] WS server error:', error);
      this.listener.onError(error);
    });

    return assignedPort;
  }

  async stop(): Promise<void> {
    if (!this.wsServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      console.info('[conn] Stopping WS server');
      assertNotNull(this.wsServer);
      this.wsServer.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      console.info('[conn] Stopping HTTP server');
      assertNotNull(this.httpServer);
      this.httpServer.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * A connection has been established between the server and a client. Only ever used for
   * certificate exchange.
   *
   * @param ws An active WebSocket.
   * @param request Incoming request message.
   */
  onConnection(ws: WebSocket, request: IncomingMessage): void {
    const ctx: ConnectionCtx = {ws, request};
    this.handleClientQuery(ctx);
    this.handleConnectionAttempt(ctx);

    ws.on('message', async (message: WebSocket.RawData) => {
      try {
        const messageString = message.toString();
        const parsedMessage = this.handleMessageDeserialization(messageString);
        // Successful deserialization is a proof that the message is a string
        this.handleMessage(ctx, parsedMessage, messageString);
      } catch (error) {
        // See the reasoning in the error handler for a `connection` event
        ws.emit('error', error);
        ws.close(WSCloseCode.InternalError);
      }
    });
  }

  protected handleClientQuery(ctx: ConnectionCtx): void {
    const {request} = ctx;

    const query = querystring.decode(request.url!.split('?')[1]);
    const clientQuery = this.parseClientQuery(query);

    if (!clientQuery) {
      console.error(
        '[conn] Unable to extract the client query from the request URL.',
      );
      throw new Error(
        '[conn] Unable to extract the client query from the request URL.',
      );
    }

    ctx.clientQuery = clientQuery;
  }

  protected handleConnectionAttempt(ctx: ConnectionCtx): void {
    const {clientQuery} = ctx;
    assertNotNull(clientQuery);

    console.info(
      `[conn] Insecure websocket connection attempt: ${clientQuery.app} on ${clientQuery.device_id}.`,
    );
    this.listener.onConnectionAttempt(clientQuery);
  }

  protected handleMessageDeserialization(message: unknown): object {
    const parsedMessage = parseMessageToJson(message);
    if (!parsedMessage) {
      console.error('[conn] Failed to parse message', message);
      // TODO: Create custom DeserializationError
      throw new Error(`[conn] Failed to parse message`);
    }
    return parsedMessage;
  }

  protected async handleMessage(
    ctx: ConnectionCtx,
    parsedMessage: object,
    // Not used in this method, but left as a reference for overriding classes
    _rawMessage: string,
  ) {
    const {clientQuery, ws} = ctx;
    assertNotNull(clientQuery);

    const response = await this._onHandleUntrustedMessage(
      clientQuery,
      parsedMessage,
    );
    if (response) {
      ws.send(response);
    }
  }

  /**
   * Parse and extract a ClientQuery instance from a message. The ClientQuery
   * data will be contained in the message url query string.
   * @param message An incoming web socket message.
   */
  protected parseClientQuery(
    query: querystring.ParsedUrlQuery,
  ): ClientQuery | undefined {
    return verifyClientQueryComesFromCertExchangeSupportedOS(
      parseClientQuery(query),
    );
  }

  /**
   * WebSocket client verification. Usually used to validate the origin.
   *
   * Base implementation simply returns true, but this can be overriden by subclasses
   * that require verification.
   *
   * @returns Return true if the client was successfully verified, otherwise
   * returns false.
   */
  protected verifyClient(): VerifyClientCallbackSync {
    return (_info: {origin: string; req: IncomingMessage; secure: boolean}) => {
      // Client verification is not necessary. The connected client has
      // already been verified using its certificate signed by the server.
      return true;
    };
  }
}

export default ServerWebSocket;
