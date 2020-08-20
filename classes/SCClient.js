'use strict';

const sc_client = require('socketcluster-client');

/**
 * class to handle creation & basic listeners for a connection to a socket cluster server
 * @type {SCClient}
 */
module.exports = class SCClient{
    constructor(host, port, client_name) {
        this.socket = sc_client.create({hostname: host, port:port});
        this.client_name = client_name;
        this.createListeners();
    }

    createListeners(){
        this.errorListener().then();
        this.connectListener().then();
        this.getChannelDataProcedureListener().then();
    }

    /**
     * logs any errors that occur for the socket
     * @returns {Promise<void>}
     */
    async errorListener() {
        for await (let {error} of this.socket.listener('error')) {
            console.error(error);
        }
    }

    /**
     * handles to connect event with a SC server and invokes the server's login function to authenticate
     * @returns {Promise<void>}
     */
    async connectListener() {
        for await (let event of this.socket.listener('connect')) {
            console.log('Socket is connected');
            try {
                await Promise.all([
                    this.socket.invoke('login', {username: "kyle", password: "thebestpassword", client_name: this.client_name}),
                    this.socket.listener('authenticate').once(),
                ]);
                console.log('Socket is auth!');
            } catch (e) {
                console.error(e.message);
            }
        }
    }

    async getChannelDataProcedureListener(){
        for await (let request of this.socket.procedure('getChannelData')) {
            request.end({});
            continue;
        }
    }

    /**
     * creates a listener on an sc server's channel
     * @param channel
     * @param logic_function
     * @returns {Promise<void>}
     */
    async subscriptionListener(channel, logic_function = undefined){
        try {
            for await (let data of this.socket.subscribe(channel)) {
                if(logic_function === undefined) {
                    console.log(data);
                } else{
                    logic_function(data);
                }
            }
        }catch (e) {
            console.error(e);
        }
    }
}