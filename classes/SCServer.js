'use strict';

const http = require('http');
const path = require('path');
const RestServer = require('./RestServer');
const SCClient = require('./SCClient');
const sc_server = require('socketcluster-server');
const csvtojson = require("csvtojson");
const {promisify} = require('util');
const p_timeout = promisify(setTimeout);

const USERS_CSV_PATH = path.resolve(__dirname, '../', 'data', 'users.csv');

/**
 * class to spawn an http, socket cluster & express servers all running on the same port
 * @type {SCServer}
 */
module.exports = class SCServer{
    constructor(port, server_name) {
        //create http & socket cluster server
        this.http_server = http.createServer();
        this.sc_server = sc_server.attach(this.http_server, {});
        this.http_server.listen(port);
        this.port = port;
        this.server_name = server_name;

        //Set up listeners & middleware function
        this.createListeners();
        this.sc_server.setMiddleware(this.sc_server.MIDDLEWARE_INBOUND, this.inboundMiddlewareHandler.bind(this));
        this.sc_server.setMiddleware(this.sc_server.MIDDLEWARE_OUTBOUND, this.outboundMiddlewareHandler.bind(this));
        this.outbound_connections = new Map();

        //Create the resat server
        this.rest_server = new RestServer(this, this.http_server, server_name, this);
    }

    createListeners(){
         this.disconnectionListener().then(()=>{});
         this.readyListener().then(()=>{});
         this.errorListener().then(()=>{});
        this.connectionListener().then(()=>{});
    }

    /**
     * logs disconnection
     * @returns {Promise<void>}
     */
    async disconnectionListener(){
        for await (let {socket, code, reason} of this.sc_server.listener('disconnection')) {
            console.log(`socket ${socket.id} disconnected with code ${code} due to ${reason}`);
        }
    }

    /**
     * logs when the server is ready
     * @returns {Promise<void>}
     */
    async readyListener() {
        for await (let data of this.sc_server.listener('ready')) {
            console.log('SC Server is ready');
        }
    }

    /**
     * logs out errors
     * @returns {Promise<void>}
     */
    async errorListener() {
        for await (let {error} of this.sc_server.listener('error')) {
            console.error(error);
        }
    }

    /**
     * listens for inbound connections
     * @returns {Promise<void>}
     */
    async connectionListener(){
        for await (let {socket, id} of this.sc_server.listener('connection')) {
            console.log(`socket ${id} connected`);
            //listen for when the socket invokes the RPC for login
            this.loginProcedureListener(socket).then(()=>{});
            this.getChannelDataProcedureListener(socket).then(()=>{});
        }
    }

    /**
     * RPC listener for a socket's login
     * @param socket
     * @returns {Promise<void>}
     */
    async loginProcedureListener(socket){
        for await (let request of socket.procedure('login')) {
            try {
                let credentials = request.data;
                if(typeof credentials !== "object" || credentials === undefined || credentials === null){
                    request.error(new Error('Invalid credentials'));
                    continue;
                }

                let users = await csvtojson().fromFile(USERS_CSV_PATH);

                let found_user = false;
                for(let x = 0; x < users.length; x++){
                    let user = users[x];
                    if(credentials.username === user.username && credentials.password === user.password){
                        found_user = true;
                        break;
                    }
                }

                if(found_user === true){
                    await socket.setAuthToken({username: credentials.username, client_name: credentials.client_name, server_name: this.server_name});
                    request.end('Success');
                    continue;
                }

                request.error(new Error('Invalid credentials'));
                continue;
            }catch(e){
                request.error(e);
            }
        }
    }

    async getChannelDataProcedureListener(socket){
        for await (let request of socket.procedure('getChannelData')) {
            try {
                let channel = request.data;

                let data = await this.rest_server.getChannelData(channel);

                request.end({server: this.server_name, data: data});
                continue;
            }catch(e){
                request.error(e);
            }
        }
    }

    /**
     * handles inbound socket requests subscribe, publish in, invoke, transmit, authenticate
     * @param middlewareStream
     * @returns {Promise<void>}
     */
    async inboundMiddlewareHandler(middlewareStream){
        for await (let action of middlewareStream) {
            switch (action.type) {
                case action.SUBSCRIBE:
                case action.TRANSMIT:
                case action.PUBLISH_IN:
                    if (action.socket.authState === action.socket.UNAUTHENTICATED) {
                        action.block(new Error('socket not authenticated'));
                        continue;
                    }

                    if(action.type === action.PUBLISH_IN && action.data ) {
                        //we want to write the data & on success the functon will send it on
                        this.rest_server.writeChannelData(action.channel, action.data);
                        action.block();
                        continue;
                    }
                    action.allow();
                    continue;
                default:
                    action.allow();
                    continue;
            }
        }
    }

    /**
     * handles all traffic out to connected sockets, this is always publish out
     * @param middlewareStream
     * @returns {Promise<void>}
     */
    async outboundMiddlewareHandler(middlewareStream) {
        for await (let action of middlewareStream) {
            if (action.socket.authState === action.socket.UNAUTHENTICATED) {
                action.block(new Error('socket not authenticated'));
                continue;
            }
            //add this server to originators
            action.data = this.setOriginator(this.server_name, action.data);
            //only allow if the connecting node was not an originator
            if(this.originatorCheck(action.socket.authToken.client_name, action.data)){
                action.allow();
                continue;
            }

            action.block();
        }
    }

    /**
     * send data to channel which will immediately publish out to connections
     * @param channel
     * @param data
     */
    publishDataToExchange(channel, data){
        this.sc_server.exchange.transmitPublish(channel, data);
    }

    /**
     * invoked to create a direct connection to another sc server & publish or subscribe
     * @param host
     * @param port
     * @param subscriptions
     * @returns {Promise<void>}
     */
    async connectToServer(host, port, subscriptions){
        let connection = new SCClient(host, Number(port), this.server_name);
        connection.server_name = this.server_name;
        this.outbound_connections.set(host + port, connection);
        await p_timeout(200);
        subscriptions.forEach(subscription=>{
            if(subscription.publish === true){
                this.exchangeSubscriptionHandler(subscription.channel, connection).then();
            }

            if(subscription.subscribe === true){
                connection.subscriptionListener(subscription.channel, (data)=>{
                    this.rest_server.writeChannelData(subscription.channel, data);
                });
            }
            this.getChannelDataProcedureListener(connection.socket).then();
        });
    }

    /**
     * createws a "local" channel listener and pushes data out to a specific connection
     * @param channel
     * @param connection
     * @returns {Promise<void>}
     */
    async exchangeSubscriptionHandler(channel, connection){
        for await(let data of this.sc_server.exchange.subscribe(channel)){
            //add originator for this server
            data = this.setOriginator(this.server_name, data);
            //check if the remote server is an originator
            if(this.originatorCheck(connection.socket.authToken.server_name, data)){
                connection.socket.transmitPublish(channel, data);
            }
        }
    }

    /**
     * check the originator attribute on the data to see if the intended target has already handled this data, this is to prevent loop backs
     * @param originator_name
     * @param data
     * @returns {boolean|*}
     */
    originatorCheck(originator_name, data){
        if(!originator_name || !data){
            return data;
        }

        return data.originators[originator_name] === undefined;
    }

    /**
     * sets an originator to later make sure this node does not get the same payload again
     * @param originator_name
     * @param data
     * @returns {{}|*}
     */
    setOriginator(originator_name, data){
        if(!originator_name || !data){
            return data;
        }

        let new_data = {};

        if(typeof data !== "object" || (typeof data === "object" && !('originators' in data))){
            new_data = {
                originators: {
                    [originator_name]:1
                },
                raw_data: data
            }
        } else {
            Object.assign(new_data, data);
            new_data.originators[originator_name] = 1;
        }

        return new_data;
    }
}