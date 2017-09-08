'use strict';

const Promise = require('bluebird');
const request = Promise.promisifyAll(require('request'));
const _ = require('lodash');
const chalk = require('chalk');
const localConfig = require('./views-config.json');

request.defaults({
  agent: false
});

/**
 * Send HTTPS request to retrieve client token
 *
 * @param {String} uaaUrl
 * @param {String} credentials
 */
const requestToken = function requestToken(uaaUrl, credentials) {
  return new Promise(function(resolve, reject) {
    request({
      url: uaaUrl + '/oauth/token',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      body: 'grant_type=client_credentials&response_type=token',
      agent: false
    }, function (error, response, body) {
      if (!error && response && response.statusCode === 200) {
        resolve(JSON.parse(body));
      } else {
        reject(`Error retrieving token. Response returned status code ${(response ? response.statusCode : 'unknown')}`);
      }
    }, reject);
  });
};

/**
 * Get or post data for a views service instance
 *
 * @param {String} url
 * @param {String} zoneId
 * @param {String} token
 * @param {String} [method]
 * @param {Object} [body]
 */
const requestViewsData = function requestAssetData (url, zoneId, token, method, body) {
  return new Promise((resolve, reject) => {
    try {
      request({
        url: url,
        headers: {
          'Predix-Zone-Id': zoneId,
          'Authorization': token
        },
        method: method ? method : 'GET',
        json: body ? true : false,
        body: body ? body : null,
        agent: false
      }, function (error, response, responseBody) {
        if (error || (response && response.statusCode.toString().indexOf('2') !== 0)) {
          reject(`Request ${url}\nMethod: ${method ? method : 'GET'}\nZone ID: ${zoneId}\nBody: ${JSON.stringify(body)}\nStatus code: ${(response ? response.statusCode : 'unknown')}\nResponse body: ${JSON.stringify(responseBody)}`);
          return;
        } else {
          resolve({
            body: (responseBody && typeof responseBody === 'string') ? JSON.parse(responseBody) : responseBody,
            headers: response && response.headers ? response.headers : {}
          });
          return;
        }
      });
    } catch (e) {
      reject(e);
    }
  });
};

/**
 * For a given endpoint, loop through and delete all data
 *
 * @param {Array} items
 * @param {String} url
 * @param {String} zoneId
 * @param {String} token
 * @param {String} type
 */
const deleteData = function deleteData (items, url, zoneId, token, type) {
  return new Promise((resolve, reject) => {
    const promises = [];
    console.log(chalk.bold(`Deleting ${chalk.cyan(items.length)} ${type}s from ${chalk.cyan(zoneId)}`));
    _.each(items, (item) => {
      const itemUrl = `${url}/${item.id}`;
      const promise = requestViewsData(itemUrl, zoneId, token, 'DELETE');
      promises.push(promise);
      promise.then(() => console.log(`Deleted ${type} ${chalk.cyan(item.id)} from ${chalk.cyan(zoneId)}`));
    });
    Promise.all(promises).then(() => resolve());
  });
};

/**
 * Add tags to a list of cards or decks
 *
 * @param {String} url
 * @param {Array} list
 * @param {String} zoneId
 * @param {String} token
 * @return {Promise}
 */
const addTags = function addTags (url, list, zoneId, token) {
  return new Promise((resolve, reject) => {
    const promises = [];
    console.log(list.length);
    _.each(list, (item) => {
      if (item && item.tags && item.tags.length > 0) {
        const promise = requestViewsData(`${url}/${item.id}/tags`, zoneId, token, 'POST', item.tags.map((tag) => {
          return {
            value: tag.value
          };
        }));
        promises.push(promise);
        promise.then(() => console.log(`Posted ${chalk.cyan(item.tags.length)} tags to ${chalk.cyan(item.id)}`));
      }
    });
    Promise.all(promises).then(() => resolve());
  });
};

/**
 * Setup and return a config object
 *
 * @param {Object} config
 */
const getConfig = function getConfig(config) {
  config.originalCardsUrl = `${config.originalViewsUrl}/api/cards`;
  config.originalDecksUrl = `${config.originalViewsUrl}/api/decks`;
  config.destinationCardsUrl = `${config.destinationViewsUrl}/api/cards`;
  config.destinationDecksUrl = `${config.destinationViewsUrl}/api/decks`;
  config.originalToken = '';
  config.destinationToken = '';
  return config;
};

const migrateGenerator = Promise.coroutine(function* migrateGenerator() {
  // Get the config information from the localConfig file.
  const config = getConfig(localConfig);

  // Get the origin token
  console.log(chalk.bold(`Retrieving token for origin ${chalk.cyan(config.originalViewsZoneId)}`));
  config.originalToken = `Bearer ${(yield requestToken(config.originalUaaUrl, config.originalUaaCredentials)).access_token}`;
  console.log(chalk.bold.green(`OK\n`));

  // Get the destination token
  console.log(chalk.bold(`Retrieving token for destination ${chalk.cyan(config.destinationViewsZoneId)}`));
  config.destinationToken = `Bearer ${(yield requestToken(config.destinationUaaUrl, config.destinationUaaCredentials)).access_token}`;
  console.log(chalk.bold.green(`OK\n`));

  // Check if the destination data should be removed
  if (config.clearDestination) {
    console.log(chalk.bold(`Deleting data from destination ${chalk.cyan(config.destinationViewsZoneId)}`));
    const cards = (yield requestViewsData(config.destinationCardsUrl, config.destinationViewsZoneId, config.destinationToken)).body;
    const decks = (yield requestViewsData(config.destinationDecksUrl, config.destinationViewsZoneId, config.destinationToken)).body;
    yield deleteData(cards, config.destinationCardsUrl, config.destinationViewsZoneId, config.destinationToken, 'card');
    yield deleteData(decks, config.destinationDecksUrl, config.destinationViewsZoneId, config.destinationToken, 'deck');
    console.log(chalk.bold.green(`OK\n`));
  }

  // Get all original cards
  console.log(chalk.bold(`Retrieving all cards for instance ${chalk.cyan(config.originalViewsZoneId)}`));
  const cards = (yield requestViewsData(config.originalCardsUrl, config.originalViewsZoneId, config.originalToken)).body;
  console.log(`Found ${chalk.cyan(cards.length)} total cards\n`);

  // Post original cards to new destination
  console.log(chalk.bold(`Posting ${chalk.cyan(cards.length)} total cards to the destination views service instance`));
  yield requestViewsData(`${config.destinationViewsUrl}/api/cards`, config.destinationViewsZoneId, config.destinationToken, 'POST', cards);
  const destinationCards = (yield requestViewsData(`${config.destinationViewsUrl}/api/cards`, config.destinationViewsZoneId, config.destinationToken)).body;
  console.log(chalk.bold.green(`OK\n`));

  // Post the original tags to the new cards
  console.log(chalk.bold(`Posting tags to cards`));
  yield addTags(config.destinationCardsUrl, cards, config.destinationViewsZoneId, config.destinationToken);
  console.log(chalk.bold.green(`OK\n`));

  // Get all original decks
  console.log(chalk.bold(`Retrieving all decks for instance ${chalk.cyan(config.originalViewsZoneId)}`));
  const decks = (yield requestViewsData(`${config.originalDecksUrl}?filter[include][cards]`, config.originalViewsZoneId, config.originalToken)).body;
  console.log(`Found ${chalk.cyan(decks.length)} total decks\n`);

  // Post original decks to the new destination
  console.log(chalk.bold(`Posting ${chalk.cyan(decks.length)} total decks to destination ${chalk.cyan(config.destinationViewsZoneId)}`));
  yield requestViewsData(config.destinationDecksUrl, config.destinationViewsZoneId, config.destinationToken, 'POST', decks);
  console.log(chalk.bold.green(`OK\n`));

  // Post the original tags to the new decks
  console.log(chalk.bold(`Posting tags to decks`));
  yield addTags(config.destinationDecksUrl, decks, config.destinationViewsZoneId, config.destinationToken);
  console.log(chalk.bold.green(`OK\n`));

  // Associate the original cards to the new decks
  console.log(chalk.bold(`Posting cards to decks`));
  _.each(decks, (deck) => {
    if (deck && deck.attributes && deck.attributes.cards && deck.attributes.cards.length > 0) {
      requestViewsData(`${config.originalDecksUrl}/${deck.id}/cards/add`, config.originalViewsZoneId, config.originalToken, 'POST', deck.attributes.cards.map((card) => {
        return card.id;
      }));
    }
  });
  yield new Promise((resolve, reject) => {
    const promises = [];
    _.each(decks, (deck) => {
      if (deck && deck.cards && deck.cards.length > 0) {
        console.log(`Posting ${chalk.cyan(deck.cards.length)} cards to deck ${chalk.cyan(deck.id)}`)
        const promise = requestViewsData(`${config.destinationDecksUrl}/${deck.id}/cards/add`, config.destinationViewsZoneId, config.destinationToken, 'POST', deck.cards.map((card) => {
          return card.id;
        }));
        promises.push(promise);
        promise.then(() => console.log(`Posted ${chalk.cyan(deck.cards.length)} cards to deck ${chalk.cyan(deck.id)}`));
      }
    });
    Promise.all(promises).then(() => resolve());
  });
  console.log(chalk.bold.green(`OK\n`));
});

migrateGenerator()
  .then(() => console.log(chalk.bold(`\nFinished migrating the Predix Views service.`)))
  .catch((error) => console.log(chalk.bold.red(error)));
