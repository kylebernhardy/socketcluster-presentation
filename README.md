# Code Sample for my SocketCluster Presentaion

This project shows how to create a socket cluster server with an integrated REST API, a socket cluster client to connect to an instance of a socket cluster server. 
The REST API shows how you can: 
* POST data to write and push to a channel with the /write/:channel endpoint
* GET data for a channel with the /read/:channel endpoint
* Connect one SC Server to another with the /connect endpoint
* Read data from all connected nodes with the /read_all/:channel endpoint

This project also exhibits:
* How to wire in Authentication/Authorization with JWT
* How to make RPC calls, create listeners & middleware

