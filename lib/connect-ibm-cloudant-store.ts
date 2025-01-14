import * as CloudantV1 from "@ibm-cloud/cloudant/cloudant/v1.js";
import dbg from "debug";
const debug = dbg("express-session:cloudant-store")
import { Store, MemoryStore, SessionData, Session } from "express-session";

function getTTL(store: IBMCloudantStore, sess: SessionDataDocument) {
    var maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : null;
    return store.ttl || (typeof maxAge === 'number' ? Math.floor(maxAge / 1000) : 86400);
};

function sessionToDb(sid: string, sess: SessionDataDocument, ttl: number) {
    var dbData = Object.assign({}, JSON.parse(JSON.stringify(sess)),
        {_id: sid, session_ttl: ttl, session_modified: Date.now()});
    return dbData;
};

export interface IBMCloudantStoreOptions {
    client: CloudantV1;
    prefix?: string
    ttl?: number
    db?: string;
    expiredSessionsDBViewName?: string;
    expiredSessionsDDocName?: string;
}

export type SessionDataDocument = SessionData & {
    _rev: string;
    _id: string;
    session_ttl: number;
    session_modified: number;
}

export class IBMCloudantStore extends Store {

    client: CloudantV1;
    prefix: string;
    ttl: number;
    db: string;
    expiredSessionsDBViewName: any;
    expiredSessionsDDocName: any;

    constructor(opts: IBMCloudantStoreOptions) {
        super()

        this.client = opts.client;
        this.prefix = opts.prefix == null ? "sess:" : opts.prefix;
        this.ttl = opts.ttl || 86400; // One day in seconds.
        this.db = opts.db || "sessions";

        this.expiredSessionsDBViewName = opts.expiredSessionsDBViewName || 'express_expired_sessions';
        this.expiredSessionsDDocName = opts.expiredSessionsDDocName || 'expired_sessions';

        
    }

    async init() {
        // Database
        try {
            const result = await this.client.putDatabase({db: this.db})
            if (result.result.ok) {
                debug(`Created ${this.db} database for sessions`);
            }
        }
        catch (e: any) {
            if (e.code === 412) {
                debug(`Session database "${this.db}" exists`);
            }
            else {
                debug(e);
                throw e;
            }
        }

        // View
        try {
            const expiredSessionsMap = {
                map: "function(doc) { if (doc.session_ttl && doc.session_modified && Date.now() > (doc.session_ttl + doc.session_modified)) { emit(doc._id, doc._rev); }}"
            }
            const ddoc: CloudantV1.DesignDocument = {
                views: {[this.expiredSessionsDBViewName]: expiredSessionsMap}
            }
            const result = await this.client.putDesignDocument({
                db: this.db,
                designDocument: ddoc,
                ddoc: this.expiredSessionsDDocName
            });
            if (result.result.ok) {
                debug(`Created ${this.expiredSessionsDDocName} Expired View`);
            }
        }
        catch (e: any) {
            if (e.code === 409) {
                debug(`Design Doc "${this.expiredSessionsDDocName}" exists`);
            }
            else {
                debug(e);
                throw e;
            }
        }
    }

    async get(sid: string, callback: (err?: any, session?: SessionData | null) => void): Promise<void> {
        debug('GET "%s"', sid);
        try {
            const results = await this.client.getDocument({
                db: this.db,
                docId: this.prefix + sid
            });
            
            const doc = results.result;
            if (doc.session_modified + doc.session_ttl * 1000 < Date.now()) {
                debug('GET "%s" expired session', sid);
                await this.destroy(sid);
                return callback();
            }
            else {
                debug('GET "%s" found rev "%s"', sid, doc._rev);
                return callback(null, doc as SessionData);
            }
        }
        catch (e: any) {
            if (e.code == 404) {
                debug('GET - SESSION NOT FOUND "%s"', sid);
                return callback();
            } else {
                // TODO 429 errors from a custom promise-retry cloudant plugin
                debug('GET ERROR  "%s" err "%s"', sid, JSON.stringify(e));
                this.emit('error', e);
                return callback(e);
            }
        }
    }
    
    async set(sid: string, session: SessionDataDocument, callback?: (err?: any) => void): Promise<void> {
        try {
            // Get the latest _rev if it exists
            try {
                const headResult = await this.client.headDocument({
                    db: this.db,
                    docId: this.prefix + sid
                });
                const etag = headResult.headers['etag'] as string;
                // @ts-ignore
                session._rev = etag.replace(/"/g, '');
            }
            catch (e: any) {
                if (e.code !== 404) {
                    debug('SET session error "%s" rev "%s" err "%s"', sid, session._rev, JSON.stringify(e));
                    this.emit('error', e);
                    if (callback) {
                        return callback(e);
                    }
                }
            }
            
            debug('SET session "%s" rev "%s"', sid, session._rev);
            try {
                const doc = sessionToDb(this.prefix + sid, session, getTTL(this, session));
                const result = await this.client.postDocument({
                    db: this.db,
                    document: doc
                });
                if (callback) {
                    return callback();
                }
                return;
            }
            catch (e) {
                debug('SET session error "%s" rev "%s" err "%s"', sid, session._rev, JSON.stringify(e));
                this.emit('error', e);
                if (callback)
                    return callback(e)
                return;
            }
        }
        catch (e) {
            debug('SET session error "%s" rev "%s" err "%s"', sid, session._rev);
            this.emit('error', e);
            if (callback)
                return callback(e)
            return;
        }
    }
    
    async destroy(sid: string, callback?: (err?: any) => void): Promise<void> {
        debug('DESTROY session "%s"', sid);

        try {
            let sessionDoc: SessionDataDocument;
            try {
                const sessionDocResult = await this.client.getDocument({
                    db: this.db,
                    docId: this.prefix + sid
                });
                sessionDoc = sessionDocResult.result as SessionDataDocument;
            }
            catch (e) {
                debug('DESTROY - DB GET failure "%s" err "%s"', sid, JSON.stringify(e));
                this.emit('error', e);
                if (callback) {
                    return callback(e);
                }
                return;
            }

            try {
                const result = await this.client.deleteDocument({
                    db: this.db,
                    docId: this.prefix + sid,
                    rev: sessionDoc._rev
                });
                if (callback) {
                    return callback();
                }
            }
            catch (e) {
                debug('DESTROY - DB error "%s" rev "%s" err "%s"', sid, sessionDoc._rev, JSON.stringify(e));
                this.emit('error', e);
                if (callback) {
                    return callback(e);
                }
                return;
            }
        }
        catch (e: any) {
            debug('DESTROY - error "%s" err "%s"', sid, JSON.stringify(e));
            this.emit('error', e);
            if (callback) {
                return callback(e);
            }
            return;
        }
    }


    async touch(sid: string, session: SessionDataDocument, callback?: () => void): Promise<void> {
        try {
            const sessionDocResult = await this.client.getDocument({
                db: this.db,
                docId: this.prefix + sid
            });
            const sessionDataDocument = sessionDocResult.result as SessionDataDocument;
            session._rev = sessionDataDocument._rev!!;

            try {
                const doc = sessionToDb(this.prefix + sid, sessionDataDocument, getTTL(this, session));
                const result = await this.client.postDocument({
                    db: this.db,
                    document: doc
                });
                if (callback) {
                    return callback();
                }
                return;
            }
            catch (e) {
                debug('SET session error "%s" rev "%s" err "%s"', sid, session._rev, JSON.stringify(e));
                this.emit('error', e);
                if (callback)
                    return callback();
                return;
            }

        }
        catch (e) {
            debug('TOUCH - error "%s" err "%s"', sid, JSON.stringify(e));
            this.emit('error', e);
            if (callback) {
                return callback();
            }
            return;
        }
    }
}