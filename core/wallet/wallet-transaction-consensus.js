import database from '../../database/database';
import eventBus from '../event-bus';
import network from '../../net/network';
import peer from '../../net/peer';
import peerRotation from '../../net/peer-rotation';
import genesisConfig from '../genesis/genesis-config';
import config from '../config/config';
import async from 'async';
import _ from 'lodash';
import wallet from './wallet';
import walletUtils from './wallet-utils';
import ntp from '../ntp';
import console from '../console';
import task from '../task';
import cache from '../cache';


export class WalletTransactionConsensus {

    constructor() {
        this._transactionValidationState            = {
            /*[ws.nodeID]: {
             transaction_id: id,
             timestamp: int
             }*/
        };
        this._consensusRoundState                   = {
            /*[transaction.transaction_id]: {
             consensus_round_validation_count  : int,
             consensus_round_invalid_count     : int,
             consensus_round_double_spend_count: int,
             consensus_round_not_found_count   : int,
             consensus_round_count             : int,
             consensus_round_response: array,
             timestamp: int,
             resolve : func,
             active  : bool
             }*/
        };
        this._transactionValidationRejected         = new Set();
        this._validationPrepareState                = {
            /*[transaction.transaction_id] : {
             transaction_not_found_count: int
             }*/
        };
        this._transactionRetryValidation            = new Set();
        this._transactionValidationNotFound         = new Set();
        this._transactionObjectCache                = {};
        this._runningValidationForWalletTransaction = false;
    }

    initialize() {
        task.scheduleTask('trigger', () => this.doValidateTransaction(), 15000);
        return Promise.resolve();
    }

    isRunningValidationForWalletTransaction() {
        return this._runningValidationForWalletTransaction;
    }

    addTransactionToCache(transaction) {
        this._transactionObjectCache[transaction.transaction_id] = transaction;
    }

    deleteTransactionFromCache(transactionID) {
        delete this._transactionObjectCache[transactionID];
    }

    getRejectedTransactionList() {
        return this._transactionValidationRejected;
    }

    getRetryTransactionList() {
        return this._transactionRetryValidation;
    }

    removeFromRetryTransactions(transactionID) {
        delete this._transactionRetryValidation[transactionID];
    }

    removeFromRejectedTransactions(transactionID) {
        this._transactionValidationRejected.delete(transactionID);
    }

    resetTransactionValidationRejected() {
        this._transactionValidationRejected = new Set();
    }

    _getValidInputOnDoubleSpend(doubleSpendTransactionID, inputs, nodeID, transactionVisitedSet, doubleSpendSet, proxyTimeStart, proxyTimeLimit) {
        return new Promise(resolve => {
            let responseType = 'transaction_double_spend';
            let responseData = null;
            async.eachSeries(inputs, (input, callback) => {
                database.firstShardZeroORShardRepository('transaction', input.shard_id, transactionRepository => {
                    return new Promise((resolve, reject) => {
                        transactionRepository.getTransaction(input.transaction_id)
                                             .then(transaction => transaction ? resolve(transaction) : reject()).catch(reject);
                    });
                }).then(transaction => {
                    transaction = transaction || this._transactionObjectCache[input.transaction_id];
                    if (!transaction) {
                        responseType = 'transaction_not_found';
                        responseData = {transaction_id: input.transaction_id};
                        return callback(true);
                    }
                    else if (transaction.status === 3) { // invalid transaction
                        return callback();
                    }
                    else if (!doubleSpendSet.has(transaction.transaction_id) && (!responseData || transaction.transaction_date < responseData.transaction_date
                                                                                 || ((transaction.transaction_date.getTime() === responseData.transaction_date.getTime()) && (transaction.transaction_id < responseData.transaction_id)))) {

                        let newVisitedTransactionSet = new Set(transactionVisitedSet);
                        newVisitedTransactionSet.add(doubleSpendTransactionID);
                        this._validateTransaction(transaction.transaction_id, nodeID, 0, newVisitedTransactionSet, doubleSpendSet, proxyTimeStart, proxyTimeLimit)
                            .then(() => {
                                responseType = 'transaction_valid';
                                responseData = transaction;
                                callback();
                            })
                            .catch(err => {
                                if (err.cause === 'transaction_double_spend') {
                                    doubleSpendSet.add(transaction.transaction_id);
                                    return callback();
                                }
                                else if (err.cause === 'transaction_not_found' || err.cause === 'transaction_invalid') {
                                    responseType = err.cause;
                                    responseData = {transaction_id: err.transaction_id_fail};
                                }
                                else if (err.cause === 'proxy_time_limit_exceed') {
                                    responseType = err.cause;
                                    responseData = {};
                                }
                                else {
                                    responseType = 'transaction_double_spend_unresolved';
                                    responseData = {transaction_id: transaction.transaction_id};
                                }
                                callback(true);
                            });
                    }
                    else {
                        callback();
                    }
                }).catch(() => callback());
            }, () => resolve({
                response_type: responseType,
                data         : responseData
            }));
        });
    }

    _validateTransaction(transaction, nodeID, depth = 0, transactionVisitedSet = new Set(), doubleSpendSet = new Set(), proxyTimeStart = null, proxyTimeLimit = null) {
        let transactionID;
        if (typeof (transaction) === 'object') {
            transactionID = transaction.transaction_id;
        }
        else {
            transactionID = transaction;
            transaction   = null;
        }
        const startTime = Date.now();
        return new Promise((resolve, reject) => {
            (() => transaction ? Promise.resolve(transaction) :
                   this._transactionObjectCache[transactionID] ? Promise.resolve(this._transactionObjectCache[transactionID]) :
                   database.firstShards((shardID) => {
                       return new Promise((resolve, reject) => {
                           const transactionRepository = database.getRepository('transaction', shardID);
                           transactionRepository.getTransactionObject(transactionID)
                                                .then(transaction => transaction ? resolve(transaction) : reject());
                       });
                   }))().then((transaction) => {

                if (transaction && transaction.status !== 3 && transaction.is_stable && _.every(transaction.transaction_output_list, output => output.is_stable && !output.is_double_spend)) {
                    console.log('[wallet-transaction-consensus-oracle] validated in consensus round after find a validated transaction at depth ', depth, '. after:', Date.now() - startTime, 'ms');
                    return resolve();
                }
                else if (transaction && transaction.status === 3) {
                    return reject({
                        cause              : 'transaction_invalid',
                        transaction_id_fail: transactionID,
                        message            : 'invalid transaction found: ' + transactionID
                    });
                }
                else if (transaction && transaction.is_stable && _.some(transaction.transaction_output_list, output => output.is_double_spend === 1) ||
                         doubleSpendSet.has(transactionID)) {
                    return reject({
                        cause                         : 'transaction_double_spend',
                        transaction_id_fail           : transactionID,
                        transaction_input_double_spend: _.pick(_.find(transaction.transaction_input_list, {is_double_spend: 1}) || transaction.transaction_input_list[0], [
                            'output_transaction_id',
                            'output_position',
                            'output_shard_id'
                        ]),
                        message                       : 'double spend found in ' + transactionID
                    });
                }
                else if (transaction && transaction.transaction_id === genesisConfig.genesis_transaction) {
                    return resolve();
                }
                else if (transactionVisitedSet.has(transactionID)) {
                    return resolve();
                }
                else if (depth === config.CONSENSUS_VALIDATION_REQUEST_DEPTH_MAX) {
                    return reject({
                        cause              : 'transaction_validation_max_depth',
                        transaction_id_fail: transactionID,
                        message            : `not validated in a depth of ${depth}`
                    });
                }

                if (transaction && transaction.is_stable !== undefined) { // transaction object needs to be normalized
                    transaction = database.getRepository('transaction').normalizeTransactionObject(transaction);
                }

                if (!transaction) {
                    wallet.requestTransactionFromNetwork(transactionID, {
                        priority        : 1,
                        dispatch_request: true
                    });

                    return reject({
                        cause              : 'transaction_not_found',
                        transaction_id_fail: transactionID,
                        message            : 'no information found for ' + transactionID
                    });
                }

                walletUtils.verifyTransaction(transaction)
                           .then(valid => {
                               if (!valid) {
                                   return reject({
                                       cause              : 'transaction_invalid',
                                       transaction_id_fail: transaction.transaction_id,
                                       message            : `invalid transaction found: ${transaction.transaction_id}`
                                   });
                               }

                               transactionVisitedSet.add(transactionID);

                               let sourceTransactions        = new Set();
                               let inputTotalAmount          = 0;
                               const outputUsedInTransaction = new Set();
                               // get inputs and check double
                               // spend
                               async.everySeries(transaction.transaction_input_list, (input, callback) => {
                                   if (doubleSpendSet.has(input.output_transaction_id)) {
                                       return callback({
                                           cause                         : 'transaction_double_spend',
                                           transaction_id_fail           : transaction.transaction_id,
                                           transaction_input_double_spend: _.pick(input, [
                                               'output_transaction_id',
                                               'output_position',
                                               'output_shard_id'
                                           ]),
                                           message                       : 'double spend found in ' + transaction.transaction_id
                                       }, false);
                                   }

                                   (() => {
                                       if (!transactionVisitedSet.has(input.output_transaction_id)) {
                                           sourceTransactions.add(input);
                                           return database.applyShards((shardID) => database.getRepository('transaction', shardID).getInputDoubleSpend(input, transaction.transaction_id)).then(data => data || []);
                                       }
                                       else {
                                           return Promise.resolve([]);
                                       }
                                   })().then(doubleSpendTransactions => {
                                       return new Promise((resolve, reject) => {
                                           if (doubleSpendTransactions.length > 0) {
                                               doubleSpendTransactions.push({
                                                   transaction_id: transaction.transaction_id,
                                                   shard_id      : transaction.shard_id,
                                                   ...input
                                               });
                                               this._getValidInputOnDoubleSpend(input.output_transaction_id, doubleSpendTransactions, nodeID, transactionVisitedSet, doubleSpendSet, proxyTimeStart, proxyTimeLimit)
                                                   .then(({
                                                              response_type: responseType,
                                                              data
                                                          }) => {

                                                       if ((responseType === 'transaction_double_spend' && !data) ||
                                                           (responseType === 'transaction_valid' && data.transaction_id !== transaction.transaction_id)) {
                                                           return reject({
                                                               cause                         : 'transaction_double_spend',
                                                               transaction_id_fail           : transaction.transaction_id,
                                                               message                       : 'double spend found in ' + transaction.transaction_id,
                                                               transaction_input_double_spend: _.pick(input, [
                                                                   'output_transaction_id',
                                                                   'output_position',
                                                                   'output_shard_id'
                                                               ])
                                                           });
                                                       }
                                                       else if (responseType === 'transaction_not_found') {

                                                           wallet.requestTransactionFromNetwork(data.transaction_id, {
                                                               priority        : 1,
                                                               dispatch_request: true
                                                           });

                                                           return reject({
                                                               cause              : responseType,
                                                               transaction_id_fail: data.transaction_id,
                                                               message            : 'no information found for ' + data.transaction_id
                                                           });
                                                       }
                                                       else if (responseType === 'transaction_double_spend_unresolved') {
                                                           peer.transactionSyncRequest(data.transaction_id, {
                                                               dispatch_request  : true,
                                                               force_request_sync: true
                                                           }).then(_ => _).catch(_ => _);
                                                           return reject({
                                                               cause              : 'transaction_double_spend_unresolved',
                                                               transaction_id_fail: data.transaction_id,
                                                               message            : 'unresolved double spend. unknown state of transaction id ' + data.transaction_id
                                                           });
                                                       }
                                                       else if (responseType === 'proxy_time_limit_exceed') {
                                                           return reject({
                                                               cause  : responseType,
                                                               message: 'transaction proxy time limit exceeded'
                                                           });
                                                       }

                                                       resolve();
                                                   });
                                           }
                                           else {
                                               resolve();
                                           }
                                       });
                                   }).then(() => {
                                       /* get the total millix amount of this input */
                                       database.firstShards((shardID) => {
                                           return new Promise((resolve, reject) => {
                                               if (this._transactionObjectCache[input.output_transaction_id]) {
                                                   return resolve(_.find(this._transactionObjectCache[input.output_transaction_id].transaction_output_list, {output_position: input.output_position}));
                                               }
                                               const transactionRepository = database.getRepository('transaction', shardID);
                                               transactionRepository.getOutput(input.output_transaction_id, input.output_position)
                                                                    .then(output => output ? resolve(output) : reject());
                                           });
                                       }).then(output => {
                                           if (!output) {

                                               wallet.requestTransactionFromNetwork(input.output_transaction_id, {
                                                   priority        : 1,
                                                   dispatch_request: true
                                               });

                                               return callback({
                                                   cause              : 'transaction_not_found',
                                                   transaction_id_fail: input.output_transaction_id,
                                                   message            : 'no information found for ' + input.output_transaction_id
                                               }, false);
                                           }

                                           let outputID = input.output_transaction_id + ':' + input.output_position;

                                           const outputAddress = output.address || `${output.address_base}${output.address_version}${output.address_key_identifier}`;

                                           if (outputUsedInTransaction.has(outputID)) {
                                               return callback({
                                                   cause              : 'transaction_invalid',
                                                   transaction_id_fail: input.output_transaction_id,
                                                   message            : 'output already used ' + outputID
                                               }, false);
                                           }
                                           else if (outputAddress !== `${input.address_base}${input.address_version}${input.address_key_identifier}`) {
                                               return callback({
                                                   cause              : 'transaction_invalid',
                                                   transaction_id_fail: transactionID,
                                                   message            : `invalid input address ${input.address_base}${input.address_version}${input.address_key_identifier}`
                                               }, false);
                                           }
                                           outputUsedInTransaction.add(outputID);
                                           inputTotalAmount += output.amount;
                                           return callback(null, true);
                                       }).catch(() => {
                                           return callback({
                                               cause              : 'peer_error',
                                               transaction_id_fail: transactionID,
                                               message            : 'generic database error when getting data for transaction id ' + input.output_transaction_id
                                           }, false);
                                       });
                                   }).catch(err => {
                                       callback(err, false);
                                   });
                               }, (err, valid) => {
                                   if (err && !valid) { //not valid
                                       return reject(err);
                                   }

                                   if (nodeID && (!this._transactionValidationState[nodeID] || (Date.now() - this._transactionValidationState[nodeID].timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX)) { //timeout has been triggered
                                       return reject({
                                           cause: 'consensus_timeout',
                                           depth
                                       });
                                   }
                                   else if (proxyTimeLimit != null && proxyTimeStart != null && (Date.now() - proxyTimeStart) >= proxyTimeLimit) {
                                       return reject({
                                           cause: 'proxy_time_limit_exceed',
                                           depth
                                       });
                                   }

                                   /* compare input and output amount */
                                   let outputTotalAmount = 0;
                                   _.each(transaction.transaction_output_list, output => {
                                       outputTotalAmount += output.amount;
                                   });

                                   if (outputTotalAmount > inputTotalAmount) {
                                       return reject({
                                           cause              : 'transaction_invalid_amount',
                                           transaction_id_fail: transactionID,
                                           message            : 'output amount is greater than input amount in transaction id ' + transactionID
                                       });
                                   }


                                   // check inputs transactions
                                   async.everySeries(sourceTransactions, (srcTransaction, callback) => {
                                       this._validateTransaction(this._transactionObjectCache[srcTransaction.output_transaction_id] || srcTransaction.output_transaction_id, nodeID, depth + 1, transactionVisitedSet, doubleSpendSet, proxyTimeStart, proxyTimeLimit)
                                           .then(() => callback(null, true))
                                           .catch((err) => {
                                               if (err && err.cause === 'transaction_double_spend' && !err.transaction_input_double_spend) {
                                                   err.transaction_input_double_spend = _.pick(srcTransaction, [
                                                       'output_transaction_id',
                                                       'output_position',
                                                       'output_shard_id'
                                                   ]);
                                               }
                                               callback(err, false);
                                           });
                                   }, (err, valid) => {
                                       if (err && !valid) {
                                           return reject(err);
                                       }
                                       resolve();
                                   });

                               });
                           });
            });
        });
    }

    _validateTransactionInConsensusRound(data, ws) {
        const {
                  node,
                  nodeID,
                  connectionID
              }             = ws;
        const transactionID = data.transaction_id;

        if (!this._transactionValidationState[ws.nodeID] ||
            this._transactionValidationState[ws.nodeID].transaction_id !== data.transaction_id ||
            !!this._transactionValidationState[ws.nodeID].timestamp) {
            return peer.transactionValidationResponse({
                cause              : 'transaction_validation_unexpected',
                transaction_id_fail: transactionID,
                transaction_id     : transactionID,
                valid              : false,
                type               : 'validation_response'
            }, ws, true);
        }

        console.log('[wallet-transaction-consensus-oracle] request received to validate transaction ', transactionID);
        eventBus.emit('wallet_event_log', {
            type   : 'transaction_validation_start',
            content: data,
            from   : node
        });

        this._transactionValidationState[nodeID]['timestamp'] = Date.now();
        this._validateTransaction(transactionID, nodeID)
            .then(() => {
                console.log('[wallet-transaction-consensus-oracle] transaction ', transactionID, ' was validated for a consensus');
                let ws = network.getWebSocketByID(connectionID);
                if (ws) {
                    const validationResult = {
                        transaction_id: transactionID,
                        valid         : true,
                        type          : 'validation_response'
                    };
                    cache.setCacheItem('validation', transactionID, validationResult, 90000);
                    peer.transactionValidationResponse(validationResult, ws, true);
                }
                delete this._transactionValidationState[nodeID];
            })
            .catch((err) => {
                console.log('[wallet-transaction-consensus-oracle] consensus error: ', err);

                delete this._transactionValidationState[nodeID];
                let ws        = network.getWebSocketByID(connectionID);
                let cacheTime = 90000;
                if (err.cause === 'consensus_timeout') {
                    return;
                }
                else if (err.cause === 'transaction_not_found') {
                    ws && peer.transactionSyncByWebSocket(err.transaction_id_fail, ws).then(_ => _);
                    wallet.requestTransactionFromNetwork(err.transaction_id_fail);
                    cacheTime = 2000;
                }

                if (ws) {
                    const validationResult = {
                        ...err,
                        transaction_id: transactionID,
                        valid         : false,
                        type          : 'validation_response'
                    };
                    cache.setCacheItem('validation', transactionID, validationResult, cacheTime);
                    peer.transactionValidationResponse(validationResult, ws, true);
                }
            });

    }

    _selectNodesForConsensusRound(numberOfNodes = config.CONSENSUS_ROUND_NODE_COUNT, excludeNodeSet = new Set()) {
        return _.sampleSize(_.filter(network.registeredClients, ws => ws.nodeConnectionReady && !excludeNodeSet.has(ws.nodeID)), numberOfNodes);
    }

    _isNeedNodesInConsensusRound(transactionID) {
        const consensusData = this._consensusRoundState[transactionID];
        if (!consensusData || !consensusData.consensus_round_response) {
            return false;
        }

        // check if we have all answers
        const consensusNodeIDList = _.keys(consensusData.consensus_round_response[consensusData.consensus_round_count]);
        return consensusNodeIDList.length < config.CONSENSUS_ROUND_NODE_COUNT * 3;
    }

    _startConsensusRound(transactionID) {
        return database.firstShards((shardID) => {
            return new Promise((resolve, reject) => {
                const transactionRepository = database.getRepository('transaction', shardID);
                transactionRepository.getTransactionObject(transactionID)
                                     .then(transaction => transaction ? resolve(transaction) : reject());
            });
        })
                       .then(dbTransaction => database.getRepository('transaction').normalizeTransactionObject(dbTransaction))
                       .then(transaction => {

                           if (!transaction) { // transaction data not found
                               console.warn('[wallet-transaction-consensus] transaction not found. unexpected behaviour.');
                               return Promise.reject();
                           }

                           console.log('[wallet-transaction-consensus]', transactionID, ' is ready for consensus round');
                           if (transactionID === genesisConfig.genesis_transaction) { // genesis transaction
                               return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                                   return transactionRepository.setTransactionAsStable(transactionID)
                                                               .then(() => transactionRepository.setOutputAsStable(transactionID))
                                                               .then(() => transactionRepository.setInputsAsSpend(transactionID));
                               });
                           }

                           let scheduledRequestPeerValidation = false;
                           return new Promise(resolve => {
                               const requestPeerValidation = () => {
                                   console.log('[wallet-transaction-consensus] requesting peer for validation.');
                                   if (!this._isNeedNodesInConsensusRound(transactionID)) {
                                       console.log('[wallet-transaction-consensus] no more peer needed yet.');
                                       return;
                                   }
                                   const consensusData     = this._consensusRoundState[transactionID];
                                   consensusData.timestamp = Date.now();
                                   let consensusNodeIDList = [];
                                   for (let i = 0; i < consensusData.consensus_round_count + 1; i++) {
                                       consensusNodeIDList = consensusNodeIDList.concat(_.keys(consensusData.consensus_round_response[i]));
                                   }
                                   const [selectedWS] = this._selectNodesForConsensusRound(1, new Set(consensusNodeIDList));

                                   if (!selectedWS) {
                                       console.log('[wallet-transaction-consensus] no node ready for this consensus round');
                                       //TODO: trigger peer rotation? check the best way to do it
                                       if (!scheduledRequestPeerValidation) {
                                           scheduledRequestPeerValidation = true;
                                           return setTimeout(() => {
                                               scheduledRequestPeerValidation = false;
                                               requestPeerValidation();
                                           }, 4000);
                                       }
                                       return;
                                   }

                                   console.log('[wallet-transaction-consensus] new node selected for consensus ', selectedWS.nodeID);
                                   consensusData.consensus_round_response[consensusData.consensus_round_count][selectedWS.nodeID] = {response: null};
                                   const consensusRoundNumber                                                                     = consensusData.consensus_round_count;
                                   peer.transactionValidationRequest({transaction_id: transactionID}, selectedWS)
                                       .then(data => {
                                           selectedWS.consensusTimeoutCount = 0;
                                           if (data.type !== 'validation_start') {
                                               console.log('[wallet-transaction-consensus] node', selectedWS.nodeID, ' did not accept to validate the transaction', transactionID);
                                               // reset node to available
                                               setTimeout(() => {
                                                   if (this._consensusRoundState[transactionID]) {
                                                       try {
                                                           delete this._consensusRoundState[transactionID].consensus_round_response[consensusRoundNumber][selectedWS.nodeID];
                                                       }
                                                       catch (e) {
                                                           console.log(e);
                                                       }
                                                   }
                                               }, 5000);
                                           }
                                           else {
                                               console.log('[wallet-transaction-consensus] node', selectedWS.nodeID, ' accepted to validate the transaction', transactionID);
                                           }
                                           if (data.type !== 'validation_start' || this._isNeedNodesInConsensusRound(transactionID)) {
                                               requestPeerValidation();
                                           }
                                       })
                                       .catch((e) => {
                                           // remove node from
                                           // consensus round
                                           console.log('[wallet-transaction-consensus] error on node', selectedWS.nodeID, ' when selected to validate transaction', transactionID, '. error:', e);

                                           if (e === 'node_connection_closed') {
                                               console.log('[wallet-transaction-consensus] disconnecting node', selectedWS.nodeID, ', reason:', e);
                                               network.disconnectWebSocket(selectedWS);
                                               peerRotation.doPeerRotation();
                                           }
                                           else if (e === 'node_timeout') {
                                               selectedWS.consensusTimeoutCount += 1;
                                               console.log('[wallet-transaction-consensus] node timeout count:', selectedWS.consensusTimeoutCount);
                                               if (selectedWS.consensusTimeoutCount >= 15) {
                                                   console.log('[wallet-transaction-consensus] disconnecting node', selectedWS.nodeID, ', reason:', e);
                                                   network.disconnectWebSocket(selectedWS);
                                                   peerRotation.doPeerRotation();
                                               }
                                           }
                                           else {
                                               console.log('[wallet-transaction-consensus] unhandled error: ', e);
                                           }

                                           if (this._consensusRoundState[transactionID]) {
                                               try {
                                                   delete this._consensusRoundState[transactionID].consensus_round_response[consensusRoundNumber][selectedWS.nodeID];
                                               }
                                               catch (e) {
                                                   console.log(e);
                                               }
                                           }
                                           if (!scheduledRequestPeerValidation) {
                                               scheduledRequestPeerValidation = true;
                                               return setTimeout(() => {
                                                   scheduledRequestPeerValidation = false;
                                                   requestPeerValidation();
                                               }, 1000);
                                           }
                                       });

                                   if (!scheduledRequestPeerValidation) {
                                       scheduledRequestPeerValidation = true;
                                       return setTimeout(() => {
                                           scheduledRequestPeerValidation = false;
                                           requestPeerValidation();
                                       }, 1000);
                                   }
                               };

                               requestPeerValidation();
                               this._consensusRoundState[transactionID]['transaction']           = transaction;
                               this._consensusRoundState[transactionID]['resolve']               = resolve;
                               this._consensusRoundState[transactionID]['requestPeerValidation'] = requestPeerValidation;
                           });
                       });
    }

    processTransactionValidationRequest(data, ws) {
        // deal with the allocation process
        const cachedValidation = cache.getCacheItem('validation', data.transaction_id);
        if (cachedValidation) {
            peer.transactionValidationResponse({
                ...data,
                type: 'validation_start'
            }, ws);
            peer.transactionValidationResponse(cachedValidation, ws, true);
            if (cachedValidation.cause !== 'transaction_not_found') {
                cache.refreshCacheTime('validation', data.transaction_id, 90000);
            }
            return;
        }

        if (_.keys(this._transactionValidationState).length >= config.CONSENSUS_VALIDATION_PARALLEL_REQUEST_MAX) {
            peer.transactionValidationResponse({
                ...data,
                type: 'node_not_available'
            }, ws);
        }
        else {
            // lock a spot in the validation queue
            this._transactionValidationState[ws.nodeID] = {transaction_id: data.transaction_id};
            peer.transactionValidationResponse({
                ...data,
                type: 'validation_start'
            }, ws);

            this._validateTransactionInConsensusRound(data, ws);
        }
    }

    _nextConsensusRound(transactionID) {
        const consensusData = this._consensusRoundState[transactionID];
        if (consensusData.consensus_round_count === config.CONSENSUS_ROUND_VALIDATION_MAX - 1) {
            console.log('[wallet-transaction-consensus] could not validate transaction', transactionID, ' using ', config.CONSENSUS_ROUND_VALIDATION_MAX, 'consensus rounds');
            consensusData.active = false;
            this._transactionValidationRejected.add(transactionID);
            this._transactionRetryValidation[transactionID] = Date.now();
            consensusData.resolve();
        }
        else {
            // clear node that did not respond
            const consensusRoundResponseData = consensusData.consensus_round_response[consensusData.consensus_round_count];
            for (let [nodeID, consensusNodeResponseData] of Object.entries(consensusRoundResponseData)) {
                if (!consensusNodeResponseData.response) {
                    delete consensusRoundResponseData[nodeID];
                }
            }

            consensusData.consensus_round_count++;
            consensusData.consensus_round_response[consensusData.consensus_round_count] = {};
            consensusData.timestamp                                                     = Date.now();
            consensusData.requestPeerValidation && consensusData.requestPeerValidation();
            console.log('[wallet-transaction-consensus] move to next consensus number', consensusData.consensus_round_count, ' on transaction', transactionID);
        }
    }

    processTransactionValidationResponse(data, ws) {
        const transactionID = data.transaction_id;
        const consensusData = this._consensusRoundState[transactionID];
        if (!ws || !consensusData || !consensusData.consensus_round_response || !consensusData.consensus_round_response[consensusData.consensus_round_count][ws.nodeID] || !consensusData.active) {
            console.log('[wallet-transaction-consensus] response accepted ', data, 'for consensus', consensusData);
            return;
        }

        // update time to timeout
        consensusData.timestamp = Date.now();

        console.log('[wallet-transaction-consensus] received reply for this consensus round from ', ws.node);
        console.log('[wallet-transaction-consensus] response', data);

        eventBus.emit('wallet_event_log', {
            type   : 'transaction_validation_response',
            content: data,
            from   : ws.node
        });

        if (data.valid === false && ![
            'transaction_double_spend',
            'transaction_not_found',
            'transaction_invalid',
            'transaction_invalid_amount'
        ].includes(data.cause)) {
            delete this._consensusRoundState[transactionID].consensus_round_response[consensusData.consensus_round_count][ws.nodeID];
            this._consensusRoundState[transactionID].requestPeerValidation && this._consensusRoundState[transactionID].requestPeerValidation();
            return;
        }
        else if (data.cause === 'transaction_not_found') {
            return database.firstShards((shardID) => {
                return new Promise((resolve, reject) => {
                    const transactionRepository = database.getRepository('transaction', shardID);
                    transactionRepository.getTransactionObject(data.transaction_id_fail)
                                         .then(transaction => transaction ? resolve(transactionRepository.normalizeTransactionObject(transaction)) : reject());
                }).then(transaction => peer.transactionSendToNode(transaction, ws));
            }).then(transaction => {
                if (!transaction) {
                    peer.transactionSyncRequest(data.transaction_id_fail, {dispatch_request: true}).then(_ => _).catch(_ => _);
                    return;
                }
                peer.transactionSendToNode(transaction, ws);
            });
        }

        const consensusResponseData      = this._consensusRoundState[transactionID].consensus_round_response[consensusData.consensus_round_count];
        consensusResponseData[ws.nodeID] = {response: data};

        if (_.keys(consensusResponseData).length < config.CONSENSUS_ROUND_NODE_COUNT) {
            return;
        }

        // check if we have all responses
        let counter = {
            valid       : 0,
            invalid     : 0,
            double_spend: 0,
            not_found   : 0
        };

        let responseCount = 0;
        for (let [_, {response}] of Object.entries(consensusResponseData)) {
            if (!response) {
                continue;
            }

            responseCount++;

            if (response.valid === true) {
                counter.valid++;
            }
            else if (response.cause === 'transaction_double_spend') {
                counter.double_spend++;
            }
            else if (response.cause === 'transaction_not_found') {
                counter.not_found++;
            }
            else { /* 'transaction_invalid', 'transaction_invalid_amount' */
                counter.invalid++;
            }
        }

        // check consensus result
        // const responseCount = _.keys(consensusResponseData).length;

        if (responseCount < config.CONSENSUS_ROUND_NODE_COUNT) {
            console.log('[wallet-transaction-consensus] current number of response is', responseCount, '. still waiting for more responses');
            return;
        }

        const isValid     = counter.valid >= 2 / 3 * responseCount;
        const transaction = consensusData.transaction;
        if (!isValid) {
            console.log('[wallet-transaction-consensus] the transaction ', transactionID, ' was not validated during consensus round number', consensusData.consensus_round_count);
            let isDoubleSpend = counter.double_spend >= 2 / 3 * responseCount;
            let isNotFound    = counter.not_found >= 2 / 3 * responseCount;
            let isInvalid     = counter.invalid >= 2 / 3 * responseCount;
            if (isDoubleSpend) {
                consensusData.consensus_round_double_spend_count++;
                console.log('[wallet-transaction-consensus] increase number of double spend rounds to', consensusData.consensus_round_double_spend_count);
                if (consensusData.consensus_round_double_spend_count >= config.CONSENSUS_ROUND_DOUBLE_SPEND_MAX) {
                    cache.removeCacheItem('validation', transactionID);
                    consensusData.active = false;
                    this._transactionValidationRejected.add(transactionID);
                    console.log('[wallet-transaction-consensus] the transaction ', transactionID, ' was not validated (due to double spend) during consensus round number ', consensusData.consensus_round_count);
                    return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                        return transactionRepository.updateTransactionAsDoubleSpend(transaction.transaction_id, data.transaction_input_double_spend /*double spend input*/);
                    }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(transaction.transaction_output_list, o => o.address_key_identifier))))
                                   .then(() => {
                                       consensusData.resolve();
                                   })
                                   .catch(() => {
                                       consensusData.resolve();
                                   });
                }
            }
            else if (isNotFound) {
                consensusData.consensus_round_not_found_count++;
                console.log('[wallet-transaction-consensus] increase number of not found rounds to', consensusData.consensus_round_not_found_count);
                if (consensusData.consensus_round_not_found_count >= config.CONSENSUS_ROUND_NOT_FOUND_MAX) {
                    cache.removeCacheItem('validation', transactionID);
                    consensusData.active = false;
                    console.log('[wallet-transaction-consensus] the transaction ', transactionID, ' was not validated (due to not found reply) during consensus round number ', consensusData.consensus_round_count);
                    this._transactionValidationRejected.add(transactionID);
                    return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                        return transactionRepository.timeoutTransaction(transactionID);
                    }).then(() => {
                        consensusData.resolve();
                    });
                }
            }
            else if (isInvalid) {
                consensusData.consensus_round_invalid_count++;
                console.log('[wallet-transaction-consensus] increase number of double spend rounds to', consensusData.consensus_round_invalid_count);
                if (consensusData.consensus_round_invalid_count >= config.CONSENSUS_ROUND_DOUBLE_SPEND_MAX) {
                    cache.removeCacheItem('validation', transactionID);
                    consensusData.active = false;
                    console.log('[wallet-transaction-consensus] the transaction ', transactionID, ' was not validated (due to not invalid tx) during consensus round number ', consensusData.consensus_round_count);
                    this._transactionValidationRejected.add(transactionID);
                    database.applyShards((shardID) => {
                        return database.getRepository('transaction', shardID)
                                       .invalidateTransaction(transactionID);
                    }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(transaction.transaction_output_list, o => o.address_key_identifier))))
                            .then(() => consensusData.resolve())
                            .catch(() => consensusData.resolve());
                }
            }
        }
        else {
            consensusData.consensus_round_validation_count++;
            console.log('[wallet-transaction-consensus] increase number of valid rounds to', consensusData.consensus_round_validation_count);
            if (consensusData.consensus_round_validation_count >= config.CONSENSUS_ROUND_VALIDATION_REQUIRED) {
                console.log('[wallet-transaction-consensus] transaction ', transactionID, ' validated after receiving all replies for this consensus round');
                cache.removeCacheItem('validation', transactionID);
                consensusData.active = false;

                if (!transaction) {
                    return database.getRepository('transaction')
                                   .updateTransactionAsStable(transactionID)
                                   .then(() => consensusData.resolve())
                                   .catch(() => consensusData.resolve());
                }

                return database.applyShardZeroAndShardRepository('transaction', transaction.shard_id, transactionRepository => {
                    return transactionRepository.updateTransactionAsStable(transactionID);
                }).then(() => wallet._checkIfWalletUpdate(new Set(_.map(transaction.transaction_output_list, o => o.address_key_identifier))))
                               .then(() => consensusData.resolve())
                               .catch(() => consensusData.resolve());
            }
        }
        this._nextConsensusRound(transactionID);
    }

    doConsensusTransactionValidationWatchDog() {
        for (let [transactionID, consensusData] of Object.entries(this._consensusRoundState)) {
            if (consensusData.active && (Date.now() - consensusData.timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX) {
                console.log('[wallet-transaction-consensus-watchdog] killed by watch dog txid: ', transactionID, ' - consensus round: ', consensusData.consensus_round_count);
                for (let i = 0; i <= consensusData.consensus_round_count; i++) {
                    const consensusRoundResponseData = consensusData.consensus_round_response[i];
                    for (let [nodeID, consensusNodeResponseData] of Object.entries(consensusRoundResponseData)) {
                        if (!consensusNodeResponseData.response) {
                            delete consensusRoundResponseData[nodeID];
                        }
                    }
                }
                consensusData.requestPeerValidation();
                consensusData.timestamp = Date.now();
            }
        }

        for (let [nodeID, validationData] of Object.entries(this._transactionValidationState)) {
            if ((Date.now() - validationData.timestamp) >= config.CONSENSUS_VALIDATION_WAIT_TIME_MAX) {
                delete this._transactionValidationState[nodeID];
            }
        }

        return Promise.resolve();
    }

    doValidateTransaction() {
        let consensusCount = 0;
        for (let k of _.keys(this._consensusRoundState)) {
            if (this._consensusRoundState[k].active) {
                consensusCount++;
            }
        }

        if (consensusCount >= config.CONSENSUS_VALIDATION_PARALLEL_PROCESS_MAX) {
            console.log('[wallet-transaction-consensus] maximum number of transactions validation running reached : ', config.CONSENSUS_VALIDATION_PARALLEL_PROCESS_MAX);
            return Promise.resolve();
        }

        let excludeTransactionList = Array.from(this._transactionValidationRejected.keys());
        if (excludeTransactionList.length > 900) { //max sqlite parameters are 999
            excludeTransactionList = _.sample(excludeTransactionList, 900);
        }

        // lock a spot in the consensus state
        const lockerID                      = `locker-${consensusCount}`;
        this._consensusRoundState[lockerID] = true;
        console.log('[wallet-transaction-consensus] get unstable transactions');
        return database.applyShards((shardID) => {
            return new Promise((resolve) => {
                async.mapSeries([
                    wallet.defaultKeyIdentifier,
                    ...config.EXTERNAL_WALLET_KEY_IDENTIFIER
                ], (addressKeyIdentifier, callback) => {
                    database.getRepository('transaction', shardID)
                            .getWalletUnstableTransactions(addressKeyIdentifier, excludeTransactionList)
                            .then(pendingTransactions => {
                                // filter out tx that were synced in the
                                // last 30s and not being validated yet
                                return _.filter(pendingTransactions, transaction => !(Date.now() - transaction.create_date < 30 || this._consensusRoundState[transaction.transaction_id]));
                            })
                            .then(transactionList => {
                                callback(null, transactionList);
                            })
                            .catch(() => callback(null, []));
                }, (err, data) => {
                    data = Array.prototype.concat.apply([], data);
                    if (data.length > 0) {
                        const transaction = _.minBy(data, t => t.transaction_date);
                        resolve([transaction]);
                    }
                    else {
                        resolve([]);
                    }
                });
            });
        }, 'transaction_date').then(pendingTransactions => {
            if (pendingTransactions.length === 0) {
                return database.applyShards((shardID) => {
                    return database.getRepository('transaction', shardID)
                                   .findUnstableTransaction(excludeTransactionList);
                }, 'transaction_date').then(transactions => [
                    _.filter(transactions, transaction => !(Date.now() - transaction.create_date < 30 || this._consensusRoundState[transaction.transaction_id])),
                    false
                ]);
            }
            else {
                return [
                    pendingTransactions,
                    true
                ];
            }
        }).then(([pendingTransactions, isTransactionFundingWallet]) => {
            console.log('[wallet-transaction-consensus] get unstable transactions done');
            let rejectedTransactions = _.remove(pendingTransactions, t => this._transactionValidationRejected.has(t.transaction_id) || this._consensusRoundState[t.transaction_id]);
            let pendingTransaction   = pendingTransactions[0];

            if (!pendingTransaction) {
                pendingTransaction = rejectedTransactions[0];
            }

            if (!pendingTransaction) {
                console.log('[wallet-transaction-consensus] no pending funds available for validation.');
                return;
            }

            const transactionID = pendingTransaction.transaction_id;
            console.log('[wallet-transaction-consensus] starting consensus round for ', transactionID);

            this._transactionRetryValidation[transactionID] = Date.now();
            if (isTransactionFundingWallet) {
                this._runningValidationForWalletTransaction = true;
            }

            delete this._consensusRoundState[lockerID];
            this._consensusRoundState[transactionID] = {
                timestamp: Date.now()
            };

            let unstableDateStart = ntp.now();
            unstableDateStart.setMinutes(unstableDateStart.getMinutes() - config.TRANSACTION_OUTPUT_EXPIRE_OLDER_THAN);
            if (![
                '0a0',
                '0b0',
                'la0l',
                'lb0l'
            ].includes(pendingTransaction.version)) {
                pendingTransaction.transaction_date = new Date(pendingTransaction.transaction_date * 1000);
            }
            else {
                pendingTransaction.transaction_date = new Date(pendingTransaction.transaction_date);
            }

            return (() => {
                if (unstableDateStart.getTime() < pendingTransaction.transaction_date.getTime()) { // if not hibernated yet, we try to do a local validation first
                    return this._validateTransaction(transactionID, null, 0)
                               .catch(() => Promise.resolve());
                }
                else {
                    return Promise.resolve();
                }
            })().then(() => pendingTransaction);
        }).then(pendingTransaction => {
            console.log('[wallet-transaction-consensus] transaction validated internally, starting consensus using oracles');
            // replace lock id with transaction id
            this._consensusRoundState[pendingTransaction.transaction_id] = {
                consensus_round_validation_count  : 0,
                consensus_round_invalid_count     : 0,
                consensus_round_double_spend_count: 0,
                consensus_round_not_found_count   : 0,
                consensus_round_count             : 0,
                consensus_round_response          : [{}],
                timestamp                         : Date.now(),
                active                            : true
            };

            return this._startConsensusRound(pendingTransaction.transaction_id)
                       .then(() => wallet._checkIfWalletUpdate(new Set(_.map(pendingTransaction.transaction_output_list, o => o.address_key_identifier))))
                       .then(() => pendingTransaction.transaction_id)
                       .catch(() => Promise.reject({transaction_id: pendingTransaction.transaction_id}));
        }).then(transactionID => {
            this._runningValidationForWalletTransaction = false;
            delete this._consensusRoundState[lockerID];
            delete this._consensusRoundState[transactionID];
            delete this._validationPrepareState[transactionID];
            //check if there is another transaction to
            // validate
            if (transactionID) {
                setTimeout(() => {
                    this.doValidateTransaction();
                }, 0);
            }
        }).catch(({transaction_id: transactionID}) => {
            this._runningValidationForWalletTransaction = false;
            delete this._consensusRoundState[lockerID];
            delete this._consensusRoundState[transactionID];
            return Promise.resolve();
        });
    }

}


export default new WalletTransactionConsensus();
