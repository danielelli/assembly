const parser = require('./shared/parser');
const compiler = require('./shared/compiler');
const { Rules } = require('./rules');
const { Core } = require('./core');
const blacklist = require('./blacklist');
const generator = require('./shared/generator');

const OWNER_BYSTANDER = 0;

const BYSTANDER_NAMES = [
    "Maverick",
    "Goose",
    "Viper",
    "Iceman",
    "Hollywood",
    "Charlie",
    "Jester",
    "Stinger",
    "Wolfman",
    "Merlin",
    "Slider",
    "Chipper",
    "Sundown",
    "Sark",
    "Clu",
    "Yori",
    "Crom",
    "Ram",
    "Chip",
    "Thorne",
    "Rinzler",
    "Tesler",
    "Link",
    "Pavel",
    "Zero",
    "Hurricane",
    "Typhoon",
    "Tornado",
    "Mirage",
    "Castor",
    "Roc",
    "Louve",
    "Striker",
    "Lancaster",
    "Kanoziev",
    "Maddox",
    "Trooper",
    "Aiglon",
    "Manta",
    "Sugar",
    "Thunder",
    "Dancer",
    "Crow",
    "Raven",
    "Xunlai",
    "Moose",
    "System",
    "CTHelper",
    "Svchost",
    "ZinLogon",
    "Haiku"
]

// const BYSTANDER_CODE = `copy 3 to 4\nadd 1 to the value at 3\njump -2`;

class LocalProgram {
    instructions;
    id;
    name;
    statistics;
    installAddress;

    getDistanceWithStartAddress(safeAddress) {
        const offset = (safeAddress - this.installAddress);

        return offset;
    }
}

module.exports = class {

    #programs = [];
    #core;
    #availableProgramIDs = [];
    #interval;
    #internalTick = 0;
    #fullTick = 0;
    #serializedBuffer;
    #scores = [];

    #lastPlayerProgramActivity = 0;
    #isBystander = {};

    // Statistics handler for each installed
    #statistics = {};


    get columnSize() {
        return this.#core.columnSize;
    }

    get columnCount() {
        return this.#core.columnCount;
    }

    get scores() {
        return this.#scores;
    }

    get serializedBuffer() {
        return this.#serializedBuffer;
    }

    get programCount() {
        return this.#core.programCount;
    }

    get activePointers() {
        const active = {};
        const nextToPlay = this.#core.getProgramPointers(this.#core.nextProgramToPlay);
        for (let i = 0; i < this.#core.programCount; i++) {
            const ptrs = this.#core.getProgramPointers(i);
            active[ptrs.programId] = {
                address: ptrs.nextAddressToExecute,
                executesNext: nextToPlay === ptrs,
                isBystander: this.#isBystander[ptrs.programId],
                ownerId:
                    this.#programs[i] == undefined || this.#programs[i].owner == undefined ?
                        OWNER_BYSTANDER :
                        this.#programs[i].owner.id
            };
        }

        return active;
    }

    // Events
    #tickEventListeners = {};
    #tickEventListenersId = 0;
    onTicked(lambda) {
        const id = this.#tickEventListenersId++;
        this.#tickEventListeners[id] = lambda;
        return function () {
            this.#tickEventListeners[id] = false;
        }.bind(this);
    }

    #broadcastOnTicked(delta) {
        for (const k in this.#tickEventListeners) {
            if (this.#tickEventListeners[k]) {
                this.#tickEventListeners[k](delta);
            }
        }
    }

    #scoreEventListeners = {};
    #scoreEventListenersId = 0;
    onScoreChanged(lambda) {
        const id = this.#scoreEventListenersId++;
        this.#scoreEventListeners[id] = lambda;
        return function () {
            this.#scoreEventListeners[id] = false;
        }.bind(this);
    }

    #broadcastOnScoreChanged(scores) {
        for (const k in this.#scoreEventListeners) {
            if (this.#scoreEventListeners[k]) {
                this.#scoreEventListeners[k](scores);
            }
        }
    }
    // End of

    constructor() {
        const rules = new Rules();
        rules.runForever = true;
        rules.columnCount = 5;
        rules.columnSize = 256;
        rules.bystanders = CONFIG.GCORE_BYSTANDERS;

        const core = new Core(rules);
        core.onProgramKilled(this.#onProgramKilled.bind(this));

        // Statistics
        core.onProgramExecutedCycle(((id) => {
            this.#statistics[id]?.notifyCycleLived();
        }).bind(this));
        core.onProgramExecutedForeignInstruction(((executerId, authorId) => {
            this.#statistics[authorId]?.notifyInstructionExecutedByForeignProgram();
        }).bind(this));
        core.onProgramWroteCell(((id, address) => {
            if (this.#statistics[id]) {
                const p = this.#programs.find(o => o.id == id);
                if (p) {
                    const dist = p.getDistanceWithStartAddress(address);
                    this.#statistics[id].notifyCellWritten(dist);
                }
            }
        }).bind(this));
        core.onProgramReadCell(((id, address) => {
            if (this.#statistics[id]) {
                const p = this.#programs.find(o => o.id == id);
                if (p) {
                    const dist = p.getDistanceWithStartAddress(address);
                    this.#statistics[id].notifyCellRead(dist);
                }
            }
        }).bind(this));

        this.#serializedBuffer = Buffer.alloc(core.maxAddress * 2);

        this.#core = core;

        for (let i = 0; i < CONFIG.MAX_PROGRAMS; i++) {
            this.#availableProgramIDs.push(i + 1);
        }

        this.#createBystanders(rules.bystanders);

        this.#interval = setInterval(this.advance.bind(this), CONFIG.CORE_SPEED / CONFIG.MAX_PROGRAMS);
    }

    kill() {
        clearInterval(this.#interval);
    }

    performNameCheck() {
        // Recheck in case banlist has changed
        for (const k in this.#programs) {
            const info = this.#programs[k];
            if (info && info.owner && info.owner.id) {
                if (blacklist.isBlacklistedName(info.name)) {
                    if (info.owner) {
                        blacklist.ban(info.owner.address);
                        log.warn(`Excluding client with address ${info.owner.address} due to creating a program named [${info.name}], and killing the running program with said name`);
                    }

                    log.info(`Killing program with forbidden name '${info.name}'`);
                    this.#core.killProgram(k);
                }
            }
        }
    }

    installProgram(name, code, ownerId = OWNER_BYSTANDER, fromAddress = false) {
        if (fromAddress !== false) { // Remote client - exercise caution
            if (blacklist.isBlacklistedName(name)) {
                blacklist.ban(fromAddress);
                log.warn(`Excluding client with address ${fromAddress} due to creating a program named [${name}]`);
                return [false, "You have been booted off the assembly! Please reach out on the discord for further assistance."];
            }
            else {
                log.debug(`Namecheck "${name}" OK`);
            }
        }

        name = name.trim();

        // Check if name already exists
        for (const k in this.#programs) {
            if (this.#programs[k].name.trim().toLowerCase() == name.toLowerCase()) {
                return [false, "Another delegate with the same name is already running!"];
            }
        }

        const id = this.#grabProgramId();

        if (id === false) {
            return [false, "The assembly is full and cannot accept new delegates at the time"];
        }

        const tokens = parser.tokenize(code);

        if (tokens.anyError) {
            return [false, "The delegate did not compile successfully due to an error in the instructions"];
        }
        else {
            const compiled = compiler.compile(tokens.tokens);

            if (fromAddress !== false) { // Remote client - exercise caution
                const blacklistReason = blacklist.isBlacklisted(compiled);
                if (blacklistReason) {
                    log.info(`Refused program [${name}] from address ${fromAddress}: ${blacklistReason}`);
                    this.#availableProgramIDs.push(id);
                    return [false, "The assembly declared your program harmful and refused your delegate. Please update your instructions and re-submit."];
                }
            }

            const program = new LocalProgram();
            program.name = name;
            program.id = id;
            program.instructions = compiled;
            program.owner = {
                address: fromAddress,
                id: ownerId
            };


            // gives a statistics handle
            if (ownerId != OWNER_BYSTANDER) {
                const stats = STATS.register(name, compiled, ownerId, tokens.meta);
                if (stats === false) {
                    log.warn(`Could not obtain a statistics registration for program ${name} by ${ownerId}!`);
                }
                else{
                    if (this.#statistics[id])
                    {
                        log.error(`This program ID already had statistics running for that core??? This is a big problem! ${name} by ${ownerId}, id ${id}`);
                    }
                    else
                    {
                        this.#statistics[id] = stats;
                    }
                }
            }

            let position = Math.floor(this.#core.maxAddress / 2);

            // Find free position in core
            if (this.#core.programCount > 0) {
                const existingPointers = this.#getOccupiedAddresses();

                const emptySegments = [];

                // Find empty segments
                {
                    let ongoingSegmentStart = 0;
                    let ongoingSegmentLength = 0;
                    for (let i = 0; i < this.#core.maxAddress; i++) {
                        if (existingPointers[i] === true) {
                            emptySegments.push({ start: ongoingSegmentStart, length: ongoingSegmentLength });
                            ongoingSegmentStart = i + 1;
                            ongoingSegmentLength = 0;
                        }
                        else {
                            ongoingSegmentLength++;
                        }
                    }

                    if (ongoingSegmentLength) {
                        emptySegments.push({ start: ongoingSegmentStart, length: ongoingSegmentLength });
                    }
                }

                // Last segment is also first segment, but this fact is ignored here
                // It's okay and it's better like this: installing program between 
                //  the end and start of the core will look weird

                // Longest segment first
                emptySegments.sort(function (a, b) { return a.length < b.length ? 1 : -1 });

                position = emptySegments[0].start + Math.floor(emptySegments[0].length / 2);
            }

            log.info(`Global core: installing program ${program.name}:${program.id} at position ${position}`);

            program.installAddress = position;

            this.#core.installProgram(program, position);
            this.#programs.push(program);
            this.#scores.push({
                id: id,
                name: program.name,
                ownerId: program.owner.id,
                kills: 0
            });

            this.#lastPlayerProgramActivity = this.#fullTick;

            return [id, "success"];
        }
    }

    advance() {
        if (this.#core.programCount > 0) {
            const pCount = Math.floor((CONFIG.MAX_PROGRAMS) / this.#core.programCount);
            if (this.#core.nextProgramToPlay * pCount == (this.#internalTick % CONFIG.MAX_PROGRAMS)) {
                const finished = this.#core.advance();
                const delta = this.#computeDelta();
                if (finished) {
                    log.error("Halted global core ???? There is trickery afoot");
                }

                this.#broadcastOnTicked(delta);
                this.#fullTick ++;
            }
            else {
                // Fixes an issue where people kill the next program that would play (not supposed to happen!!)
                this.#core.capNextProgramToPlay();
            }
        }
        else {
            this.#fullTick++;
        }

        if (this.#core.programCount < this.#core.rules.bystanders &&
            this.#fullTick - this.#lastPlayerProgramActivity > this.#core.rules.repopulateBystanderEveryTick) {

            log.debug(`Program count is ${this.#core.programCount} (< ${this.#core.rules.bystanders}) and last program activity was ${(this.#fullTick - this.#lastPlayerProgramActivity)} ticks ago (${this.#fullTick} - ${this.#lastPlayerProgramActivity}), creating a new bystander`);
            this.#createBystanders(1);
        }

        this.#internalTick ++;
    }

    killProgramIfOwned(id, ownerId) {
        for (const k in this.#programs) {
            if (this.#programs[k].id == id) {
                if (this.#programs[k].owner === OWNER_BYSTANDER) {
                    log.warn(`Client id ${ownerId} tried to kill a bystander they do not own ${this.#programs[k].id} named ${this.#programs[k].name} (owner is ${OWNER_BYSTANDER}). joker?)`);
                    return false;
                }
                else if (this.#programs[k].owner.id == ownerId) {
                    this.#core.killProgram(k);
                    return true;
                }
                else {
                    log.warn(`Client id ${ownerId} tried to kill a program they do not own ${this.#programs[k].id} named ${this.#programs[k].name})`);
                    return false;
                }
            }
        }

        log.info(`Could not kill ${id} owned by ${ownerId} (no such program)`);

        return false;
    }

    getProgramInstructions(id) {
        for (const k in this.#programs) {
            if (this.#programs[k].id == id) {
                return this.#programs[k].instructions;
            }
        }

        return false;
    }

    #createBystanders(count) {
        for (let i = 0; i < count; i++) {
            const name = `${BYSTANDER_NAMES[Math.floor(Math.random() * BYSTANDER_NAMES.length)].toLowerCase()}.d`;
            const [id, reason] = this.installProgram(name, generator.bystander.generate(true));

            if (id === false) {
                log.info(`Did not create bystander! ${reason}`);
                break;
            }

            log.info(`Created bystander ${name}:${id}`);
            this.#isBystander[id] = true;
        }
    }

    #computeDelta() {
        let delta = {};
        const pointers = this.#getOccupiedAddresses();

        for (let i = 0; i < this.#core.maxAddress; i++) {
            const value = this.#core.peek(i);

            let writer = this.#core.getLastWriterOfAdddress(i);
            if (this.#isBystander[writer]) {
                // Bystanders are gray
                writer = 0;
            }

            // X bits for op (up to )  
            const op = (value >> compiler.OPERATION_SHIFT) & compiler.OPERATION_MASK;

            // 5 bits for lastWriter (up to 31)
            const owner = (writer & ((1 << 5) - 1));

            // 1 bit for pointer
            const hasPointer = pointers[i] == true;


            let summarized = 0;
            summarized |= op;
            summarized |= owner << compiler.OPERATION_BITS;
            summarized |= hasPointer << (compiler.OPERATION_BITS + 5);
            // = 6+X bits (closest available: 16 bit integer)

            if (this.#serializedBuffer.readInt16LE(i * 2) != summarized) {
                this.#serializedBuffer.writeInt16LE(summarized, i * 2);
                delta[i] = summarized;
            }
        }

        return delta;
    }

    #getOccupiedAddresses() {
        const existingPointers = {};
        for (let i = 0; i < this.#core.programCount; i++) {
            const ptrs = this.#core.getProgramPointers(i);
            for (let k in ptrs.pointers) {
                existingPointers[ptrs.pointers[k]] = true;
            }
        }

        return existingPointers;
    }

    #grabProgramId() {
        if (this.#availableProgramIDs.length > 0) {
            return this.#availableProgramIDs.shift();
        }

        return false;
    }

    #onProgramKilled(victimId, killerId, reason) {
        // Update scores
        for (const k in this.#scores) {
            if (this.#scores[k].id == killerId) {
                this.#scores[k].kills++;
                log.info(`Scoring kill for ${killerId}`);
                break;
            }
        }

        // Propagate kill
        if (this.#statistics[killerId]) {
            if (killerId === victimId) {
                this.#statistics[killerId].notifyKilledSelf();
            }
            else if (this.#statistics[victimId]) {

                let killerAndVictimHaveSameOwner = false;
                let victimOwner = false;
                let killerOwner = false;
                for (const k in this.#programs) {
                    if (this.#programs[k].id === victimId) {
                        victimOwner = this.#programs[k].owner;
                        continue;
                    }

                    if (this.#programs[k].id === killerId) {
                        killerOwner = this.#programs[k].owner;
                        continue;
                    }
                }

                killerAndVictimHaveSameOwner = victimOwner && killerOwner && killerOwner === victimOwner;

                this.#statistics[killerId].notifyKilledOtherPlayerProgram(
                    this.#statistics[victimId].getKey(),
                    killerAndVictimHaveSameOwner
                );
            }
            else {
                this.#statistics[killerId].notifyKilledBystander();
            }
        }

        // Clear statistics
        if (this.#statistics[victimId]) {
            this.#statistics[victimId].notifyProgramDied();
            delete this.#statistics[victimId];
        }

        // Remove victim from scores
        this.#scores = this.#scores.filter(o => o.id != victimId);
        this.#programs = this.#programs.filter(o => o.id != victimId);
        this.#availableProgramIDs.push(victimId); // Release ID
        if (this.#isBystander[victimId]) {
            delete this.#isBystander[victimId];
        }

        log.info(`Program ${victimId} died (${reason}), releasing ID`);

        this.#lastPlayerProgramActivity = this.#fullTick;
        this.#broadcastOnScoreChanged(this.#scores);
    }
}
