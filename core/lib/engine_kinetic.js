/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * 
 * This Engine was based on the WSEngine that provided basic websocket send
 * functionality.
 * */

'use strict';

const async = require('async');
const _ = require('lodash');
const WebSocket = require('ws');
const debug = require('debug')('ws');
const engineUtil = require('./engine_util');
const EngineHttp = require('./engine_http');
const template = engineUtil.template;

module.exports = KineticEngine;

function KineticEngine(script) {
  this.config = script.config;
  this.httpDelegate = new EngineHttp(script);
}

KineticEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

KineticEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      if (!rs.send && !rs.loop) {
        return self.httpDelegate.step(rs, ee);
      }
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue || '$loopCount',
        overValues: requestSpec.over,
        whileTrue: self.config.processor ?
          self.config.processor[requestSpec.whileTrue] : undefined
      });
  }

  const isResponseRequired = function (spec) {
    return spec.send.response;
  }
  
  let f = function(context, callback) {
    // Only process send requests; delegate others to the HTTP engine
    if (!requestSpec.send) {
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }
    
    const finishWsResponse = function(startedAt) {
      let endedAt = process.hrtime(startedAt);
      let delta = (endedAt[0] * 1e9) + endedAt[1];
      ee.emit('response', delta, 0, context._uid);
    };

    const handleMessage = function(message) {
      _.each(expectedResponseMessages, function(expectedResponseMessage) {
        const expectedMessage = template(expectedResponseMessage, context);
        const msg = JSON.parse(message);
        // start as a match, and clear if properties don't match
        let matchedMessage = true;
        _.each(Object.getOwnPropertyNames(expectedMessage), function(prop) {
          // if the expected property doesn't match, unset matched response message
          if (matchedMessage && expectedMessage[prop]) {
            if (msg[prop] !== expectedMessage[prop]) {
              matchedMessage = false;
            }
          }
        });
        if (matchedMessage) {
          // add the received message to the array of received expected messages
          receivedExpectedMessages.push(expectedMessage);
        }
      });
      // clear the timeout if all expected resonses have been received
      if (receivedExpectedMessages.length === expectedResponseMessages.length) {
        if (responseTimeoutId) {
          clearTimeout(responseTimeoutId);
        }
        context.ws.removeEventListener('message', handleMessage);
        finishWsResponse(startedAt);
        callback(null, context);
      }
    };

    ee.emit('request');
    let startedAt = process.hrtime();

    let payload = template(requestSpec.send.payload, context);
    if (typeof payload === 'object') {
      payload = JSON.stringify(payload);
    } else {
      payload = payload.toString();
    }

    debug('WS send: %s', payload);

    let expectedResponseMessages = requestSpec.send.response;
    let receivedExpectedMessages = [];
    let responseTimeoutId = null;
    
    // setup the received messages handler
    if (isResponseRequired(requestSpec)) {
      context.ws.on('message', handleMessage);
    }

    context.ws.send(payload, function(err) {
      if (err) {
        debug(err);
        ee.emit('error', err);
        callback(err, context);
      } else {
        if (isResponseRequired(requestSpec)) {
          responseTimeoutId = setTimeout(function() {
            // should change this to compare the responses to determine
            // which are missing and give better error message
            if (receivedExpectedMessages.length !== expectedResponseMessages.length) {
              ee.emit('error', 'Expected response was not received', 1003);
            }
            context.ws.removeEventListener('message', handleMessage);
            finishWsResponse(startedAt);
            callback(null, context);
          }, (requestSpec.send.think || 1) * 1000);
        } else {
          finishWsResponse(startedAt);
          callback(null, context);
        }
      }
    });
  };

  return f;
};

KineticEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;

  return function scenario(initialContext, callback) {
    function zero(callback) {
      let tls = config.tls || {};
      let options = _.extend(tls, config.ws);

      let subprotocols = _.get(config, 'ws.subprotocols', []);
      const headers = _.get(config, 'ws.headers', {});
      const subprotocolHeader = _.find(headers, (value, headerName) => {
        return headerName.toLowerCase() === 'sec-websocket-protocol';
      });
      if (typeof subprotocolHeader !== 'undefined') {
        // NOTE: subprotocols defined via config.ws.subprotocols take precedence:
        subprotocols = subprotocols.concat(subprotocolHeader.split(',').map(s => s.trim()));
      }

      ee.emit('started');

      let ws = new WebSocket(initialContext.vars.wsTarget || config.target, subprotocols, options);

      ws.on('open', function() {
        initialContext.ws = ws;
        return callback(null, initialContext);
      });

      ws.once('error', function(err) {
        debug(err);
        ee.emit('error', err.message || err.code);
        return callback(err, {});
      });
    }

    initialContext._successCount = 0;

    let steps = _.flatten([
      zero,
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }

        if (context && context.ws) {
          context.ws.close();
        }

        return callback(err, context);
      });
  };
};
