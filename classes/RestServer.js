'use strict';

const fs = require('fs');
const express = require('express');
const body_parser = require('body-parser');
const csv_write_stream = require('csv-write-stream');
const csvtojson = require("csvtojson");
const path = require('path');
const BASE_DATA_PATH = path.resolve(__dirname, '../', 'data');

/**
 * spawns an express server & sets up routes with handlers
 */
class restServer{
    constructor(sc_server, http_server, server_name) {
        this.sc_server = sc_server;
        this.http_server = http_server;
        this.server_name = server_name;

        //create the folder
        this.data_path = path.join(BASE_DATA_PATH, server_name);
        try {
            fs.mkdirSync(this.data_path);
        }catch(e){}

        this.app = express();
        this.app.use(body_parser.json({limit: '1gb'}));
        this.app.use(body_parser.urlencoded({extended: true}));

        //routes all raw http server requests  to our express server
        this.http_server.on('request', (...args)=>{
            this.app.apply(null, args);
        });

        this.buildRoutes();
    }

    /**
     * creates the routes for our express server
     */
    buildRoutes(){
        this.app.get('/read/:channel',this.channelGetHandler.bind(this));
        this.app.get('/read_all/:channel',this.channelGetAllHandler.bind(this));
        this.app.post('/connect', this.connectHandler.bind(this));
        this.app.post('/write/:channel', this.channelPostHandler.bind(this));
    }

    /**
     * invokes a function to write the data
     * @param req
     * @param res
     * @returns {Promise<this>}
     */
    async channelPostHandler(req, res){
        let channel = req.params.channel;
        let data = req.body;

        try {
            this.writeChannelData(channel, data);
        }catch(e){
            res.status(500).json({error: e.message});
        }
        return res.status(200).json({thanks:true});
    }

    /**
     * appends the data to a csv file and then pushes it to the sc server channel
     * @param channel
     * @param data
     */
    writeChannelData(channel, data){
        let raw_data = data.raw_data ? data.raw_data : data;

        let writer = csv_write_stream({sendHeaders: false});
        writer.pipe(fs.createWriteStream(path.join(this.data_path, `${channel}.csv`), {flags: 'a'}));
        writer.write({timestamp: Date.now(), data: JSON.stringify(raw_data)});
        writer.end();

        this.sc_server.publishDataToExchange(channel, data);
    }

    /**
     * fetches data for a server's channel
     * @param req
     * @param res
     * @returns {Promise<this>}
     */
    async channelGetHandler(req, res){
        try {
            let channel = req.params.channel;
            let data = await this.getChannelData(channel);

            return res.status(200).json(data);
        }catch(e){
            res.status(500).json({error: e.message});
        }
    }

    /**
     * iterates the client connections and sends an RPC to the servers for them each to get their channel data and return it back.
     * @param req
     * @param res
     * @returns {Promise<this>}
     */
    async channelGetAllHandler(req, res){
        try {
            let channel = req.params.channel;

            let inbound_clients = this.sc_server.sc_server.clients;
            let outbound_clients = this.sc_server.outbound_connections;

            let promises = [];

            let sockets = [];
            Object.values(inbound_clients).forEach(client => {
                sockets.push(client);
            });

            Array.from(outbound_clients.values()).forEach(client => {
                sockets.push(client.socket);
            });

            let results = await Promise.all(
                sockets.map(async socket=>{
                    if(socket.state === socket.OPEN && socket.authState === socket.AUTHENTICATED) {
                        try {
                            return await socket.invoke('getChannelData', channel);
                        } catch(e){
                            return {};
                        }
                    }
                    return {};
            }));

            let local_data = await this.getChannelData(channel);
            results.push({server: this.server_name, data: local_data});

            return res.status(200).json(results);
        }catch(e){
            res.status(500).json({error: e.message});
        }
    }

    /**
     * fetches data from a server's channel file
     * @param channel
     * @returns {Promise<any[]>}
     */
    async getChannelData(channel){
        try {
            return await csvtojson({
                noheader: true,
                headers: ['date', 'value']
            }).fromFile(path.join(this.data_path, `${channel}.csv`));
        }catch(e){
            return [];
        }
    }

    /**
     * handles the connect / subscribe route, pushes the connection info to the sc server to create an outbound connection with pub &/or sub
     * @param req
     * @param res
     * @returns {Promise<void>}
     */
    async connectHandler(req, res){
        let connection = req.body;
        if( connection === undefined || connection === null){
            res.status(500).json({error: 'connection details required'});
        }

        if(!'host' in connection || !'port' in connection || !'subscriptions' in connection){
            res.status(500).json({error: 'not all connection details supplied'});
        }

        this.sc_server.connectToServer(connection.host, connection.port, connection.subscriptions);
        res.status(200).json({message:'connection successful'});
    }
}

module.exports = restServer;