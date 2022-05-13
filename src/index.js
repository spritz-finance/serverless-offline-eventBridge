"use strict";

const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const aedes = require("aedes");
const net = require("net");
const mqtt = require("mqtt");
const tcpPortUsed = require("tcp-port-used");
const Lambda = require("serverless-offline/dist/lambda").default;

class ServerlessOfflineAwsEventbridgePlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.lambda = null;
    this.options = options;
    this.config = null;
    this.port = null;
    this.hostname = null;
    this.pubSubPort = null;
    this.account = null;
    this.debug = null;
    this.importedEventBuses = {};
    this.eventBridgeServer = null;
    this.mockEventBridgeServer = null;
    this.payloadSizeLimit = null;

    this.mqServer = null;
    this.mqClient = null;

    this.eventBuses = {};
    this.subscribers = [];
    this.scheduledEvents = [];
    this.app = null;

    this.hooks = {
      "before:offline:start": () => this.start(),
      "before:offline:start:init": () => this.start(),
      "after:offline:start:end": () => this.stop(),
    };
  }

  async start() {
    await this.init();

    if (this.mockEventBridgeServer) {
      // Start Express Server
      this.eventBridgeServer = this.app.listen(this.port);
    }
  }

  async stop() {
    this.init();
    this.eventBridgeServer.close();
    if (this.lambda) await this.lambda.cleanup();
  }

  async init() {
    this.config =
      this.serverless.service.custom["serverless-offline-aws-eventbridge"] ||
      {};
    this.port = this.config.port || 5010;
    this.mockEventBridgeServer =
      "mockEventBridgeServer" in this.config
        ? this.config.mockEventBridgeServer
        : true;
    this.hostname = this.config.hostname || "127.0.0.1";
    this.pubSubPort = this.config.pubSubPort || 5011;
    this.account = this.config.account || "";
    this.region = this.serverless.service.provider.region || "us-east-1";
    this.debug = this.config.debug || true;
    this.importedEventBuses = this.config["imported-event-buses"] || {};
    this.payloadSizeLimit = this.config.payloadSizeLimit || "10mb";

    const {
      service: { custom = {}, provider },
    } = this.serverless;

    if (this.mockEventBridgeServer) {
      const inUse = await tcpPortUsed.check(this.pubSubPort);
      if (inUse) {
        this.log(
          `MQTT Broker already started by another stack on port ${this.pubSubPort}`
        );
        this.mockEventBridgeServer = false;
      } else {
        this.mqServer = net.createServer(aedes().handle);
        this.mqServer.listen(this.pubSubPort, () => {
          this.log(
            `MQTT Broker started and listening on port ${this.pubSubPort}`
          );
        });
      }
    }

    // Connect to the MQ server for any lambdas listening to EventBridge events
    this.mqClient = mqtt.connect(`mqtt://${this.hostname}:${this.pubSubPort}`);

    this.mqClient.on("connect", () => {
      this.mqClient.subscribe("eventBridge", (_err, granted) => {
        // if the client is already subscribed, granted will be an empty array.
        // This prevents duplicate message processing when the client reconnects
        if (!granted || granted.length === 0) return;

        this.log(
          `MQTT broker connected and listening on mqtt://${this.hostname}:${this.pubSubPort}`
        );
        this.mqClient.on("message", async (_topic, message) => {
          const entries = JSON.parse(message.toString());
          const invokedLambdas = this.invokeSubscribers(entries);
          if (invokedLambdas.length) {
            await Promise.all(invokedLambdas);
          }
        });
      });
    });

    const offlineOptions = custom["serverless-offline"];
    const offlineEventBridgeOptions =
      custom["serverless-offline-aws-eventbridge"];

    this.options = {
      ...this.options,
      ...provider,
      ...offlineOptions,
      ...offlineEventBridgeOptions,
    };

    if (typeof this.options.maximumRetryAttempts === "undefined") {
      this.options.maximumRetryAttempts = 10;
    }

    if (typeof this.options.retryDelayMs === "undefined") {
      this.options.retryDelayMs = 500;
    }

    const { subscribers, lambdas, scheduledEvents } = this.getEvents();

    this.eventBuses = this.extractCustomBuses();

    this.scheduledEvents = scheduledEvents;
    // loop the scheduled events and create a cron for them
    this.scheduledEvents.forEach((scheduledEvent) => {
      cron.schedule(scheduledEvent.schedule, async () => {
        if (this.debug) {
          this.log(`run scheduled function ${scheduledEvent.functionKey}`);
        }
        this.invokeSubscriber(scheduledEvent.functionKey, {
          Source: `Scheduled function ${scheduledEvent.functionKey}`,
          Resources: [],
          Detail: `{ "name": "Scheduled function ${scheduledEvent.functionKey}"}`,
        });
      });
    });

    this.createLambda(lambdas);
    this.subscribers = subscribers;

    // initialise the express app
    this.app = express();
    this.app.use(cors());
    this.app.use(
      express.json({
        type: "application/x-amz-json-1.1",
        limit: this.payloadSizeLimit,
      })
    );
    this.app.use(
      express.urlencoded({ extended: true, limit: this.payloadSizeLimit })
    );
    this.app.use((_req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, Content-Length, ETag, X-CSRF-Token, Content-Disposition"
      );
      res.header(
        "Access-Control-Allow-Methods",
        "PUT, POST, GET, DELETE, HEAD, OPTIONS"
      );
      next();
    });

    this.app.all("*", async (req, res) => {
      if (this.mqClient) {
        this.mqClient.publish("eventBridge", JSON.stringify(req.body.Entries));
      }
      res.json(this.generateEventBridgeResponse(req.body.Entries));
      res.status(200).send();
    });
  }

  /**
   * Returns an EventBridge response as defined in the official documentation:
   * https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
   */
  generateEventBridgeResponse(entries) {
    return {
      Entries: entries.map(() => {
        return {
          EventId: `xxxxxxxx-xxxx-xxxx-xxxx-${new Date().getTime()}`,
        };
      }),
      FailedEntryCount: 0,
    };
  }

  extractCustomBuses() {
    const {
      service: { resources: { Resources } = {} },
    } = this.serverless;
    const eventBuses = {};

    for (const key in Resources) {
      if (
        Object.prototype.hasOwnProperty.call(Resources, key) &&
        Resources[key].Type === "AWS::Events::EventBus"
      ) {
        eventBuses[key] = Resources[key].Properties.Name;
      }
    }

    return eventBuses;
  }

  invokeSubscribers(entries) {
    if (!entries) return [];

    const invoked = [];

    for (const entry of entries) {
      for (const { functionKey } of this.subscribers.filter((subscriber) =>
        this.verifyIsSubscribed(subscriber, entry)
      )) {
        invoked.push(this.invokeSubscriber(functionKey, entry));
      }
    }

    return invoked;
  }

  async invokeSubscriber(functionKey, entry, retry = 0) {
    const { retryDelayMs, maximumRetryAttempts: maxRetries } = this.options;
    const lambdaFunction = this.lambda.get(functionKey);
    const event = this.convertEntryToEvent(entry);
    lambdaFunction.setEvent(event);
    try {
      await lambdaFunction.runHandler();
      this.log(
        `${functionKey} successfully processed event with id ${event.id}`
      );
    } catch (err) {
      if (retry < maxRetries) {
        this.log(
          `error: ${err} occurred in ${functionKey} on ${retry}/${maxRetries}, will retry`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        await this.invokeSubscriber(functionKey, entry, retry + 1);
        return;
      }
      this.log(
        `error: ${err} occurred in ${functionKey} on attempt ${retry}, max attempts reached`
      );
      throw err;
    }
  }

  createLambda(lambdas) {
    this.lambda = new Lambda(this.serverless, this.options);
    this.lambda.create(lambdas);
  }

  verifyIsSubscribed(subscriber, entry) {
    const subscribedChecks = [];

    if (subscriber.event.eventBus && entry.EventBusName) {
      subscribedChecks.push(
        this.compareEventBusName(subscriber.event.eventBus, entry.EventBusName)
      );
    }

    if (subscriber.event.pattern) {
      if (subscriber.event.pattern.source) {
        subscribedChecks.push(
          this.verifyIfValueMatchesEventBridgePatterns(
            entry,
            "Source",
            subscriber.event.pattern.source
          )
        );
      }

      if (entry.DetailType && subscriber.event.pattern["detail-type"]) {
        subscribedChecks.push(
          this.verifyIfValueMatchesEventBridgePatterns(
            entry,
            "DetailType",
            subscriber.event.pattern["detail-type"]
          )
        );
      }

      if (entry.Detail && subscriber.event.pattern.detail) {
        const detail = JSON.parse(entry.Detail);

        const flattenedDetailObject = this.flattenObject(detail);
        const flattenedPatternDetailObject = this.flattenObject(
          subscriber.event.pattern.detail
        );

        // check for existence of every value in the pattern in the provided value
        for (const [key, value] of Object.entries(
          flattenedPatternDetailObject
        )) {
          subscribedChecks.push(
            this.verifyIfValueMatchesEventBridgePatterns(
              flattenedDetailObject,
              key,
              value
            )
          );
        }
      }
    }

    const subscribed = subscribedChecks.every((x) => x);
    return subscribed;
  }

  verifyIfValueMatchesEventBridgePatterns(object, field, patterns) {
    if (!object) {
      return false;
    }

    let matchPatterns = patterns;
    if (!Array.isArray(matchPatterns)) {
      matchPatterns = [matchPatterns];
    }

    for (const pattern of matchPatterns) {
      if (this.verifyIfValueMatchesEventBridgePattern(object, field, pattern)) {
        return true; // Return true as soon as a pattern matches the content
      }
    }

    return false;
  }

  /**
   * Implementation of content-based filtering specific to Eventbridge event patterns
   * https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html
   */
  verifyIfValueMatchesEventBridgePattern(object, field, pattern) {
    // Simple scalar comparison
    if (typeof pattern !== "object") {
      if (!(field in object)) {
        return false; // Scalar vs non-existing field => false
      }
      if (Array.isArray(object[field])) {
        return object[field].includes(pattern);
      }
      return object[field] === pattern;
    }

    // "exists" filters
    if ("exists" in pattern) {
      return pattern.exists ? field in object : !(field in object);
    }

    if ("anything-but" in pattern) {
      return !this.verifyIfValueMatchesEventBridgePattern(
        object,
        field,
        pattern["anything-but"]
      );
    }

    // At this point, result is assumed false is the field does not actually exists
    if (!(field in object)) {
      return false;
    }

    const content = object[field];
    const filterType = Object.keys(pattern)[0];

    if (filterType === "prefix") {
      return content.startsWith(pattern.prefix);
    }

    // "numeric", and "cidr" filters and the recurring logic are yet supported by this plugin.
    throw new Error(
      `The ${filterType} eventBridge filter is not supported in serverless-offline-aws-eventBridge yet. ` +
        `Please consider submitting a PR to support it.`
    );
  }

  compareEventBusName(eventBus, eventBusName) {
    if (typeof eventBus === "string") {
      return eventBus.includes(eventBusName);
    }

    if (
      Object.prototype.hasOwnProperty.call(eventBus, "Ref") ||
      Object.prototype.hasOwnProperty.call(eventBus, "Fn::Ref") ||
      Object.prototype.hasOwnProperty.call(eventBus, "Fn::GetAtt")
    ) {
      const resourceName =
        eventBus.Ref || eventBus["Fn::Ref"] || eventBus["Fn::GetAtt"][0];

      if (this.eventBuses[resourceName]) {
        return (
          this.eventBuses[resourceName] &&
          this.eventBuses[resourceName].includes(eventBusName)
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(eventBus, "Fn::ImportValue")) {
      const importedResourceName = eventBus["Fn::ImportValue"];

      return (
        this.importedEventBuses[importedResourceName] &&
        this.importedEventBuses[importedResourceName].includes(eventBusName)
      );
    }

    return false;
  }

  getEvents() {
    const { service } = this.serverless;
    const functionKeys = service.getAllFunctions();
    const subscribers = [];
    const scheduledEvents = [];
    const lambdas = [];

    for (const functionKey of functionKeys) {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({ functionKey, functionDefinition });

      if (functionDefinition.events) {
        for (const event of functionDefinition.events) {
          if (event.eventBridge) {
            if (!event.eventBridge.schedule) {
              subscribers.push({
                event: event.eventBridge,
                functionKey,
              });
            } else {
              let convertedSchedule;

              if (event.eventBridge.schedule.indexOf("rate") > -1) {
                const rate = event.eventBridge.schedule
                  .replace("rate(", "")
                  .replace(")", "");

                const parts = rate.split(" ");

                if (parts[1]) {
                  if (parts[1].startsWith("minute")) {
                    convertedSchedule = `*/${parts[0]} * * * *`;
                  } else if (parts[1].startsWith("hour")) {
                    convertedSchedule = `0 */${parts[0]} * * *`;
                  } else if (parts[1].startsWith("day")) {
                    convertedSchedule = `0 0 */${parts[0]} * *`;
                  } else {
                    this.log(
                      `Invalid·schedule·rate·syntax·'${rate}',·will·not·schedule`
                    );
                  }
                }
              } else {
                // get the cron job syntax right: cron(0 5 * * ? *)
                //
                //      min     hours       dayOfMonth  Month       DayOfWeek   Year        (AWS)
                // sec  min     hour        dayOfMonth  Month       DayOfWeek               (node-cron)
                // seconds is optional so we don't use it with node-cron
                convertedSchedule = `${event.eventBridge.schedule.substring(
                  5,
                  event.eventBridge.schedule.length - 3
                )}`;
                // replace ? by * for node-cron
                convertedSchedule = convertedSchedule.split("?").join("*");
              }
              if (convertedSchedule) {
                scheduledEvents.push({
                  schedule: convertedSchedule,
                  event: event.eventBridge,
                  functionKey,
                });
                this.log(
                  `Scheduled '${functionKey}' with syntax ${convertedSchedule}`
                );
              } else {
                this.log(
                  `Invalid schedule syntax '${event.eventBridge.schedule}', will not schedule`
                );
              }
            }
          }
        }
      }
    }

    return {
      subscribers,
      scheduledEvents,
      lambdas,
    };
  }

  convertEntryToEvent(entry) {
    try {
      const event = {
        version: "0",
        id: `xxxxxxxx-xxxx-xxxx-xxxx-${new Date().getTime()}`,
        source: entry.Source,
        account: this.account,
        time: new Date().toISOString(),
        region: this.region,
        resources: entry.Resources || [],
        detail: JSON.parse(entry.Detail),
      };

      if (entry.DetailType) {
        event["detail-type"] = entry.DetailType;
      }

      return event;
    } catch (error) {
      this.log(
        `error converting entry to event: ${error.message}. returning entry instead`
      );
      return {
        ...entry,
        id: `xxxxxxxx-xxxx-xxxx-xxxx-${new Date().getTime()}`,
      };
    }
  }

  flattenObject(object, prefix = "") {
    return Object.entries(object).reduce(
      (accumulator, [key, value]) =>
        value &&
        value instanceof Object &&
        !(value instanceof Date) &&
        !Array.isArray(value)
          ? {
              ...accumulator,
              ...this.flattenObject(value, (prefix && `${prefix}.`) + key),
            }
          : { ...accumulator, [(prefix && `${prefix}.`) + key]: value },
      {}
    );
  }

  log(message) {
    if (this.debug)
      this.serverless.cli.log(
        `serverless-offline-aws-eventbridge :: ${message}`
      );
  }
}

module.exports = ServerlessOfflineAwsEventbridgePlugin;
