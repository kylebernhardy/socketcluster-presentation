'use strict';

const SCClient = require('./classes/SCClient');
const {promisify} = require('util');
const p_timeout = promisify(setTimeout);

let client = new SCClient('localhost', 1000);
p_timeout(200).then(()=>{
    client.subscriptionListener('dog').then();
});
