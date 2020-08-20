'use strict';
const fs = require('fs');
const path = require('path');
const csv_write_stream = require('csv-write-stream');

const USERS_CSV_PATH = path.join(__dirname, 'data', 'users.csv');

try {
    fs.unlinkSync(USERS_CSV_PATH);
}catch(e){

}
let writer = csv_write_stream();
writer.pipe(fs.createWriteStream(path.join(__dirname, 'data', 'users.csv'), {flags: 'a'}));
writer.write({username: 'kyle', password:'thebestpassword'});
writer.write({username: 'coolguy', password:'thebest'});
writer.end();