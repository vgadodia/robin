/*
 * Robin Accountant
 * Copyright (c) 2020 by SilentByte <https://www.silentbyte.com/>
 */

import axios from "axios";
import {
    DateTime,
    Interval,
} from "luxon";

import log from "./log";
import { ROBIN_MESSAGES } from "./messages";

export type RobinSentiment = "negative" | "neutral" | "positive";
export type RobinDateTimeGrain = "day" | "week" | "month" | "year";

export interface IRobinContext {
    isActive: boolean;
    state: string;
    userName: string;
    lastMessageOn: DateTime;
    messageCounter: number;
    lastGreetingOn: DateTime;
    jokeCounter: number;
    lastJokeOn: DateTime;
    budget: number;
    currentExpenseItem?: string;
    currentExpenseValue?: number;
    currentExpenseIncurredOn?: DateTime;
}

interface IEphemeralContext {
    greetings: boolean;
    bye: boolean;
    thanks: boolean;

    sentiment: RobinSentiment;
    intent: string;

    item?: string;
    money?: {
        body: string;
        value: number;
    };
    moment?: {
        grain: RobinDateTimeGrain;
        value: DateTime;
    }
    interval?: {
        grain: RobinDateTimeGrain;
        value: Interval;
    };
}

export interface IRobinExpense {
    item: string;
    value: number;
    incurredOn: DateTime;
}

export interface IRobinSession {
    text?: string;
    voice?: ArrayBuffer;
    timestamp: DateTime;
    context: IRobinContext;
    queryExpenses(interval: Interval): Promise<IRobinExpense[]>;
}

export interface IRobinAddExpenseAction extends IRobinExpense {
    type: "add_expense";
}

export type  RobinAction = IRobinAddExpenseAction;

export interface IRobinResult {
    context: IRobinContext;
    messages: string[];
    actions: RobinAction[];
    wit: any;
}

export function defaultContext(): IRobinContext {
    return {
        state: "init",
        isActive: true,
        userName: "",
        lastMessageOn: DateTime.local(),
        messageCounter: 0,
        lastGreetingOn: DateTime.fromSeconds(0),
        jokeCounter: 0,
        lastJokeOn: DateTime.fromSeconds(0),
        budget: 500,
        currentExpenseItem: undefined,
        currentExpenseValue: undefined,
        currentExpenseIncurredOn: undefined,
    };
}

class RobinLogic {
    private messages: string[] = [];
    private actions: RobinAction[] = [];

    private readonly states: { [name: string]: Array<[string, () => Promise<[string] | [string, string]>]> } = {
        "init": [
            ["first_interaction", async () => {
                this.sayHi();
                this.sayWelcome();
                return ["main!"];
            }],
        ],

        "main": [
            ["request_help", async () => {
                if(this.ephemeral.intent !== "request_help") {
                    return [""];
                }

                this.say(ROBIN_MESSAGES.help.any());
                return ["main"];
            }],
            ["tell_joke", async () => {
                if(this.ephemeral.intent !== "tell_joke") {
                    return [""];
                }

                this.sayJoke();
                return ["main"];
            }],
            ["who_are_you", async () => {
                if(this.ephemeral.intent !== "who_are_you") {
                    return [""];
                }

                this.say(ROBIN_MESSAGES.introduction.any());
                return ["main"];
            }],
            ["are_you_bot", async () => {
                if(this.ephemeral.intent !== "are_you_bot") {
                    return [""];
                }

                this.say(ROBIN_MESSAGES.bot.any());
                return ["main"];
            }],
            ["delete_account", async () => {
                if(this.ephemeral.intent !== "delete_account") {
                    return [""];
                }

                this.say(ROBIN_MESSAGES.deleteAccountConfirmation.any());
                return ["delete_account"];
            }],
            ["set_budget", async () => {
                if(this.ephemeral.intent !== "set_budget") {
                    return [""];
                }

                return ["set_budget!"];
            }],
            ["query_budget", async () => {
                if(this.ephemeral.intent !== "query_budget") {
                    return [""];
                }

                const totalExpenses = (await this.session.queryExpenses(
                    Interval.fromDateTimes(
                        DateTime.local().startOf("week"),
                        DateTime.local().endOf("week"),
                    )))
                    .reduce((p, c) => p + c.value, 0);

                this.say(ROBIN_MESSAGES.queryBudget.any({
                    value: `$${this.context.budget}`,
                    balance: `$${this.context.budget - totalExpenses}`,
                }));

                return ["main"];
            }],
            ["query_affordability", async () => {
                if(this.ephemeral.intent !== "query_affordability") {
                    return [""];
                }

                if(!this.ephemeral.money) {
                    this.say(ROBIN_MESSAGES.specifyAffordabilityValue.any());
                } else {
                    const totalExpenses = (await this.session.queryExpenses(
                        Interval.fromDateTimes(
                            DateTime.local().startOf("week"),
                            DateTime.local().endOf("week"),
                        )))
                        .reduce((p, c) => p + c.value, 0);

                    this.say(ROBIN_MESSAGES.queryAffordability.any({
                        value: `$${this.ephemeral.money.value}`,
                        balance: `$${this.context.budget - totalExpenses - this.ephemeral.money.value}`,
                    }));
                }

                return ["main"];
            }],
            ["add_expense", async () => {
                if(this.ephemeral.intent !== "add_expense") {
                    return [""];
                }

                this.context.currentExpenseItem = undefined;
                this.context.currentExpenseIncurredOn = undefined;
                this.context.currentExpenseValue = undefined;

                if(!this.ephemeral.item
                    && !this.ephemeral.interval
                    && !this.ephemeral.moment
                    && !this.ephemeral.money) {
                    this.say(ROBIN_MESSAGES.addExpense.any());
                }

                return ["add_expense!"];
            }],
            ["query_summary", async () => {
                if(this.ephemeral.intent !== "query_summary") {
                    return [""];
                }

                let interval: Interval;
                if(this.ephemeral.interval) {
                    interval = this.ephemeral.interval.value;
                } else if(this.ephemeral.moment) {
                    interval = Interval.fromDateTimes(
                        this.ephemeral.moment.value.startOf(this.ephemeral.moment.grain),
                        this.ephemeral.moment.value.endOf(this.ephemeral.moment.grain),
                    );
                } else {
                    interval = Interval.fromDateTimes(
                        DateTime.local().startOf("week"),
                        DateTime.local().endOf("week"),
                    );
                }

                const expenses = await this.session.queryExpenses(interval);
                if(expenses.length === 0) {
                    this.say(ROBIN_MESSAGES.noExpenses.any({
                        start: interval.start.toLocaleString(DateTime.DATE_FULL),
                        end: interval.end.toLocaleString(DateTime.DATE_FULL),
                    }));
                } else {
                    this.say(ROBIN_MESSAGES.expenseSummary.any({
                        start: interval.start.toLocaleString(DateTime.DATE_FULL),
                        end: interval.end.toLocaleString(DateTime.DATE_FULL),
                    }));

                    this.say(
                        expenses.map(e => `${e.incurredOn.toLocaleString(DateTime.DATE_FULL)}: ${e.item}, $${e.value}`)
                            .join("\n\n"),
                    );

                    this.say(ROBIN_MESSAGES.expenseTotal.any({
                        value: "$" + expenses.reduce((p, c) => p + c.value, 0).toFixed(2).replace(".00", ""),
                    }));
                }

                return ["main"];
            }],
            ["confused", async () => {
                if(this.messages.length === 0) {
                    if(this.ephemeral.thanks) {
                        this.say(ROBIN_MESSAGES.thanks.any());
                    } else if(this.ephemeral.greetings) {
                        this.say(ROBIN_MESSAGES.hi.any());
                    } else if(this.ephemeral.bye) {
                        this.say(ROBIN_MESSAGES.bye.any({name: this.context.userName}));
                    } else {
                        this.say(ROBIN_MESSAGES.confused.any());
                    }
                }

                return ["main"];
            }],
        ],

        "delete_account": [
            ["confirmation", async () => {
                if(this.timeout(3)) {
                    return ["main", "timeout"];
                } else if(this.ephemeral.intent === "feedback_positive") {
                    this.context.isActive = false;
                    this.say(ROBIN_MESSAGES.accountDeletionConfirmed.any());
                    return ["main", "positive"];
                } else if(this.ephemeral.intent === "feedback_negative") {
                    this.say(ROBIN_MESSAGES.accountDeletionCanceled.any());
                    return ["main", "negative"];
                } else {
                    this.say(ROBIN_MESSAGES.confused.any());
                    return ["", "confused"];
                }
            }],
        ],

        "set_budget": [
            ["set_budget", async () => {
                if(!this.ephemeral.money) {
                    this.say(ROBIN_MESSAGES.specifyBudget.any());
                    return [""];
                }

                this.context.budget = this.ephemeral.money.value;
                this.say(ROBIN_MESSAGES.settingBudget.any({
                    value: `$${this.ephemeral.money.value}`,
                }));

                return ["main"];
            }],
        ],

        "add_expense": [
            ["add_expense", async () => {
                if(this.ephemeral.item && !this.context.currentExpenseItem) {
                    this.context.currentExpenseItem = this.ephemeral.item;
                }

                if(this.ephemeral.moment && !this.context.currentExpenseIncurredOn) {
                    this.context.currentExpenseIncurredOn = this.ephemeral.moment.value;
                } else if(this.ephemeral.interval && !this.context.currentExpenseIncurredOn) {
                    this.context.currentExpenseIncurredOn = this.ephemeral.interval.value.start;
                }

                if(this.ephemeral.money && !this.context.currentExpenseValue) {
                    this.context.currentExpenseValue = this.ephemeral.money.value;
                }

                if(!this.context.currentExpenseItem) {
                    return ["specify_expense_item!"];
                }

                if(!this.context.currentExpenseIncurredOn) {
                    return ["specify_expense_moment!"];
                }

                if(!this.context.currentExpenseValue) {
                    return ["specify_expense_value!"];
                }

                this.action({
                    type: "add_expense",
                    item: this.context.currentExpenseItem,
                    value: this.context.currentExpenseValue,
                    incurredOn: this.context.currentExpenseIncurredOn,
                });

                this.say(ROBIN_MESSAGES.expenseCompleted.any({
                    item: this.context.currentExpenseItem,
                    value: `$${this.context.currentExpenseValue}`,
                    moment: this.context.currentExpenseIncurredOn.toLocaleString(DateTime.DATE_FULL),
                }));

                return ["main", "expense_added"];
            }],
        ],

        "specify_expense_item": [
            ["specify_expense_item", async () => {
                if(!this.ephemeral.item) {
                    this.say(ROBIN_MESSAGES.specifyExpenseItem.any());
                    return [""];
                }

                this.context.currentExpenseItem = this.ephemeral.item;
                return ["add_expense!", "item_specified"];
            }],
        ],

        "specify_expense_moment": [
            ["specify_expense_moment", async () => {
                if(!this.ephemeral.moment && !this.ephemeral.interval) {
                    this.say(ROBIN_MESSAGES.specifyExpenseMoment.any());
                    return [""];
                }

                if(this.ephemeral.moment) {
                    this.context.currentExpenseIncurredOn = this.ephemeral.moment.value;
                } else {
                    this.context.currentExpenseIncurredOn = this.ephemeral.interval!.value.start;
                }

                return ["add_expense!", "moment_specified"];
            }],
        ],

        "specify_expense_value": [
            ["specify_expense_value", async () => {
                if(!this.ephemeral.money) {
                    this.say(ROBIN_MESSAGES.specifyExpenseValue.any());
                    return [""];
                }

                this.context.currentExpenseValue = this.ephemeral.money.value;
                return ["add_expense!", "value_specified"];
            }],
        ],
    };

    constructor(
        private wit: any,
        private ephemeral: IEphemeralContext,
        private context: IRobinContext,
        private session: IRobinSession,
    ) {
        //
    }

    private action(action: RobinAction) {
        this.actions.push(action);
    }

    private say(message: string) {
        this.messages.push(message);
    }

    private sayHi() {
        if(this.context.userName) {
            this.say(ROBIN_MESSAGES.personalGreeting.any({name: this.context.userName}));
        } else {
            this.say(ROBIN_MESSAGES.genericGreeting.any());
        }
    }

    private sayWelcome() {
        this.say(ROBIN_MESSAGES.welcome.any());
    }

    private sayJoke() {
        this.say(ROBIN_MESSAGES.joke.get(this.context.jokeCounter, ROBIN_MESSAGES.doneJoking.any()));
        this.context.jokeCounter = Math.min(this.context.jokeCounter + 1, ROBIN_MESSAGES.joke.length);
        this.context.lastJokeOn = DateTime.local();
    }

    private timeout(minutes: number): boolean {
        return this.context.lastMessageOn.diffNow("minutes").minutes > minutes;
    }

    private async execute(state: string): Promise<string> {
        const transitions = this.states[state] || this.states["init"];
        for(const t of transitions) {
            log.info(`SM trying ${state}.${t[0]}`);
            const next = await t[1]();
            if(next[0].endsWith("!")) {
                log.info(`SM transitioning to ${state}.${next.join(":")}`);
                return await this.execute(next[0].slice(0, -1));
            } else if(next[0] !== "") {
                log.info(`SM transitioning to ${state}.${next.join(":")}`);
                return next[0];
            }
        }

        log.warn("SM is out of options");
        return state;
    }

    async transition(): Promise<IRobinResult> {
        this.messages = [];

        log.info(`SM starts with ${this.context.state}`);
        this.context.state = await this.execute(this.context.state);
        log.info(`SM ends with ${this.context.state}`);

        this.context.messageCounter += 1;
        this.context.lastMessageOn = DateTime.local(); // this.session.timestamp;

        return {
            context: this.context,
            messages: this.messages,
            actions: this.actions,
            wit: this.wit,
        };
    }

    // toGraphViz(): string {
    //     let dot = "digraph {\n";
    //     dot += "    rankdir=LR\n";
    //
    //     for(const [state, transitions] of Object.entries(this.states)) {
    //         for(const t of transitions) {
    //             const matches = t[1].toString().matchAll(/return \["([^"]+)"(,\s*"([^"]+)")?]/g);
    //             for(const m of matches) {
    //                 const suffix = m[1].endsWith("!") ? "!" : "";
    //                 dot += `    ${state} -> ${m[1].replace("!", "")} [label="${m[3] || t[0]}${suffix}"]\n`;
    //             }
    //         }
    //     }
    //
    //     return dot + "}";
    // }
}

export class Robin {
    private readonly url = "https://api.wit.ai";
    private readonly version = "20200612";
    private readonly token: string;

    constructor(options: {
        token: string;
    }) {
        this.token = options.token;
    }

    private async queryWitText(message: string, timestamp: DateTime): Promise<any> {
        const response = await axios.get(`${this.url}/message`, {
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            params: {
                v: this.version,
                q: message.slice(0, 280),
                context: JSON.stringify({
                    reference_time: timestamp.toISO(),
                }),
            },
        });

        log.info(response.data);
        return response.data;
    }

    // TODO: Currently forcing voice to be in audio/mpeg format due to Wit's broken OGG support.
    private async queryWitVoice(voice: ArrayBuffer, timestamp: DateTime): Promise<any> {
        const response = await axios.post(`${this.url}/speech`, voice, {
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "audio/mpeg",
                "Accept": "application/json",
            },
            params: {
                v: this.version,
                context: JSON.stringify({
                    reference_time: timestamp.toISO(),
                }),
            },
        });

        log.info(response.data);
        return response.data;
    }

    private async queryWit(session: IRobinSession): Promise<any> {
        if(session.text) {
            return await this.queryWitText(session.text, session.timestamp);
        } else if(session.voice) {
            return await this.queryWitVoice(session.voice, session.timestamp);
        } else {
            throw new Error("Either text or voice must be given");
        }
    }

    private static processTraits(wit: any, ephemeral: IEphemeralContext) {
        ephemeral.thanks = !!wit.traits.wit$thanks;

        ephemeral.greetings = !!wit.traits.wit$greetings;
        ephemeral.bye = !!wit.traits.wit$bye;

        if(ephemeral.greetings && ephemeral.bye) {
            if(wit.traits.wit$greetings.confidence > wit.traits.wit$bye.confidence) {
                ephemeral.bye = false;
            } else {
                ephemeral.greetings = false;
            }
        }

        if(wit.traits.wit$sentiment) {
            ephemeral.sentiment = wit.traits.wit$sentiment[0].value;
        }
    }

    private static processIntents(wit: any, ephemeral: IEphemeralContext) {
        ephemeral.intent = wit.intents.map((i: any) => i.name)[0] || "";
    }

    private static processEntities(wit: any, ephemeral: IEphemeralContext) {
        const entities = Object
            .values(wit.entities as any[])
            .reduce((a, e) => {
                a.push(...e);
                return a;
            }, []);

        for(const entity of entities) {
            switch(entity.name) {
                case "item":
                    if(entity.type === "value") {
                        ephemeral.item = entity.value;
                    }
                    break;

                case "wit$amount_of_money":
                    if(entity.type === "value") {
                        ephemeral.money = {
                            body: entity.body,
                            value: entity.value,
                        };
                    }
                    break;

                case "wit$number":
                    if(entity.type === "value" && !ephemeral.money) {
                        ephemeral.money = {
                            body: entity.body,
                            value: entity.value,
                        };
                    }
                    break;

                case "wit$datetime":
                    if(entity.type === "value") {
                        ephemeral.moment = {
                            grain: entity.grain,
                            value: DateTime.fromISO(entity.value),
                        };
                    } else if(entity.typeCheck === "interval") {
                        ephemeral.interval = {
                            grain: entity.grain,
                            value: Interval.fromDateTimes(
                                DateTime.fromISO(entity.from),
                                DateTime.fromISO(entity.to),
                            ),
                        };
                    }
                    break;
            }
        }
    }

    async process(session: IRobinSession): Promise<IRobinResult> {
        const context = Object.assign({}, session.context);
        const ephemeral: IEphemeralContext = {
            greetings: false,
            bye: false,
            thanks: false,
            sentiment: "neutral",
            intent: "",
        };

        const wit = await this.queryWit(session);
        wit.intents = wit.intents || [];
        wit.entities = wit.entities || {};
        wit.traits = wit.traits || {};

        Robin.processTraits(wit, ephemeral);
        Robin.processIntents(wit, ephemeral);
        Robin.processEntities(wit, ephemeral);

        // console.log((new RobinLogic(wit, ephemeral, context, session)).toGraphViz());
        return await (new RobinLogic(wit, ephemeral, context, session)).transition();
    }
}
