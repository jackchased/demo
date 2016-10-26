/* jshint node: true */
'use strict';

var _ = require('busyman'),
    http = require('http'),
    chalk = require('chalk'),
    ZShepherd = require('zigbee-shepherd');

var model = require('./model/model'),
    ioServer = require('./helpers/ioServer');

var server = http.createServer(),
    shepherd = new ZShepherd('/dev/ttyACM0', { net: { panId: 0x7c71 }, dbPath: __dirname + '/database/dev.db' });

server.listen(3030);
ioServer.start(server);

var app = function () {
    var plugStatus = 0;

    setLeaveMsg();

/**********************************/
/* register Req handler           */
/**********************************/
    ioServer.regReqHdlr('getDevs', function (args, cb) {
        var devs = {};

        _.forEach(shepherd.list(), function (dev) {
            var eps = [];

            if (dev.nwkAddr === 0) return;

            _.forEach(dev.epList, function (epId) {
                eps.push(shepherd.find(dev.ieeeAddr, epId));
            });

            devs[dev.ieeeAddr] = getDevInfo(dev.ieeeAddr, eps);
        });

        cb(null, devs);
    });

    ioServer.regReqHdlr('permitJoin', function (args, cb) {
        if (shepherd._enabled)
            shepherd.permitJoin(args.time);

        cb(null, null);
    });

    ioServer.regReqHdlr('write', function (args, cb) {
        var auxId =  _.split(args.auxId, '/'),  // [ epId, cid, rid ]
            ieeeAddr = args.permAddr,
            epId = parseInt(auxId[0]),
            cid = auxId[2],
            val = args.value,
            ep = shepherd.find(ieeeAddr, epId);

        if (cid === 'genOnOff') {
            var cmd = val ? 'on' : 'off';
            ep.functional('genOnOff', cmd, {}, function (err, rsp) {
                cb(null, val);
            });
        }
    });

/************************/
/* Event handle         */
/************************/
    shepherd.on('ready', function () {
        readyInd();
    });

    shepherd.on('permitJoining', function (timeLeft) {
        permitJoiningInd(timeLeft);
    });

    shepherd.on('error', function (err) {
        errorInd(err.message);
    });

    shepherd.on('ind', function (msg) {
        var pirEp, lightEp, plugEp;

        switch (msg.type) {
            case 'devIncoming':
                if (msg.data === '0x00124b00072d9a1d') {  // ASUS Plug
                    msg.endpoints[0].report('genOnOff', function () { });
                } else if (msg.data === '0x000d6f000bb5508e') {  // ASUS Temp
                    msg.endpoints[0].report('msTemperatureMeasurement').then(function () {
                        return msg.endpoints[0].report('msRelativeHumidity');
                    }).fail(function () {

                    }).done();
                } else if (msg.data === '0x00124b000760b83c') {  // motion
                    pirEp = msg.endpoints[0];

                    pirEp.report('ssIasZone', function () {});
                    pirEp.onZclFunctional = function (msg) {
                        var zoneStatus = msg.zclMsg.payload.zonestatus,
                            status = getZoneStatus(zoneStatus);

                        var gadInfo = getGadInfo(pirEp)[0];

                        gadInfo.value = status.alarm1;
                        attrsChangeInd(pirEp.getIeeeAddr(), gadInfo);

                        lightEp = shepherd.find('0x00137a000001dab8', 1);

                        if (gadInfo.value && lightEp)
                            lightEp.functional('genOnOff', 'on', {}, function (err, rsp) { });
                        else if (!gadInfo.value && lightEp)
                            lightEp.functional('genOnOff', 'off', {}, function (err, rsp) { });
                    };
                }

                devIncomingInd(getDevInfo(msg.data, msg.endpoints));
                break;
            case 'devLeaving':
                devStatusInd(msg.data, 'offline');
                break;
            case 'devStatus':console.log(msg);
                devStatusInd(msg.endpoints[0].getIeeeAddr(), msg.data);
                break;
            case 'devChange':
                var gadInfo = getGadInfo(msg.endpoints[0]),
                    data = msg.data,
                    ep;

                _.forEach(gadInfo, function (info) {
                    if (info.type === 'Plug' && data.cid === 'genOnOff' && plugStatus !== data.data.onOff) {
                        plugStatus = data.data.onOff;
                        info.value = data.data.onOff;
                    } else if (info.type === 'Plug' && data.cid === 'genOnOff' && plugStatus === data.data.onOff)
                        return;

                    if (info.type === 'Temperature' && data.cid === 'msTemperatureMeasurement')
                        info.value = data.data.measuredValue / 100;

                    if (info.type === 'Humidity' && data.cid === 'msRelativeHumidity') {
                        info.value = data.data.measuredValue / 100;

                        plugEp =  shepherd.find('0x00124b00072d9a1d', 12);

                        if (info.value >= 80 && plugEp && plugStatus !== 1) {        // if Humid value >= 80, Plug on
                            plugEp.functional('genOnOff', 'on', {}, function (err, rsp) { });
                        } else if (info.value < 80 && plugEp && plugStatus !== 0) {  // Plug off
                            plugEp.functional('genOnOff', 'off', {}, function (err, rsp) { });
                        }
                    }

                    attrsChangeInd(msg.endpoints[0].getIeeeAddr(), info);
                });
                break;
            default:
                break;
        }
    });

/**********************************/
/* start shepherd                 */
/**********************************/
    shepherd.start(function (err) {
        showWelcomeMsg();
        if (err)
            console.log(err);
        else
            console.log(shepherd.info());
    });
};

/**********************************/
/* welcome function               */
/**********************************/
function showWelcomeMsg() {
var zbPart1 = chalk.blue('      ____   ____ _____ ___   ____ ____        ____ __ __ ____ ___   __ __ ____ ___   ___     '),
    zbPart2 = chalk.blue('     /_  /  /  _// ___// _ ) / __// __/ ____  / __// // // __// _ \\ / // // __// _ \\ / _ \\ '),
    zbPart3 = chalk.blue('      / /_ _/ / / (_ // _  |/ _/ / _/  /___/ _\\ \\ / _  // _/ / ___// _  // _/ / , _// // /  '),
    zbPart4 = chalk.blue('     /___//___/ \\___//____//___//___/       /___//_//_//___//_/   /_//_//___//_/|_|/____/    ');

    console.log('');
    console.log('');
    console.log('Welcome to zigbee-shepherd webapp... ');
    console.log('');
    console.log(zbPart1);
    console.log(zbPart2);
    console.log(zbPart3);
    console.log(zbPart4);
    console.log(chalk.gray('         A network server and manager for the ZigBee machine network'));
    console.log('');
    console.log('   >>> Author:     Jack Wu (jackchased@gmail.com)              ');
    console.log('   >>> Version:    zigbee-shepherd v0.2.0                      ');
    console.log('   >>> Document:   https://github.com/zigbeer/zigbee-shepherd  ');
    console.log('   >>> Copyright (c) 2016 Jack Wu, The MIT License (MIT)       ');
    console.log('');
    console.log('The server is up and running, press Ctrl+C to stop server.     ');
    console.log('---------------------------------------------------------------');
}

/**********************************/
/* goodBye function               */
/**********************************/
function setLeaveMsg() {
    process.stdin.resume();

    function showLeaveMessage() {
        console.log(' ');
        console.log(chalk.blue('      _____              __      __                  '));
        console.log(chalk.blue('     / ___/ __  ___  ___/ /____ / /  __ __ ___       '));
        console.log(chalk.blue('    / (_ // _ \\/ _ \\/ _  //___// _ \\/ // // -_)   '));
        console.log(chalk.blue('    \\___/ \\___/\\___/\\_,_/     /_.__/\\_, / \\__/ '));
        console.log(chalk.blue('                                   /___/             '));
        console.log(' ');
        console.log('    >>> This is a simple demonstration of how the shepherd works.');
        console.log('    >>> Please visit the link to know more about this project:   ');
        console.log('    >>>   ' + chalk.yellow('https://github.com/zigbeer/zigbee-shepherd'));
        console.log(' ');
        process.exit();
    }

    process.on('SIGINT', showLeaveMessage);
}

/**********************************/
/* Indication funciton            */
/**********************************/
function readyInd () {
    ioServer.sendInd('ready', {});
    console.log(chalk.green('[         ready ] Waiting for device joining...'));
}

function permitJoiningInd (timeLeft) {
    ioServer.sendInd('permitJoining', { timeLeft: timeLeft });
    console.log(chalk.green('[ permitJoining ] ') + timeLeft + ' sec');
}

function errorInd (msg) {
    ioServer.sendInd('error', { msg: msg });
    console.log(chalk.red('[         error ] ') + msg);
}

function devIncomingInd (dev) {
    ioServer.sendInd('devIncoming', { dev: dev });
    console.log(chalk.yellow('[   devIncoming ] ') + '@' + dev.permAddr);
}

function devStatusInd (permAddr, status) {
    ioServer.sendInd('devStatus', { permAddr: permAddr, status: status });
    status = (status === 'online') ? chalk.green(status) : chalk.red(status);
    console.log(chalk.magenta('[     devStatus ] ') + '@' + permAddr + ', ' + status);
}

function attrsChangeInd (permAddr, gad) {
    ioServer.sendInd('attrsChange', { permAddr: permAddr, gad: gad });
    console.log(chalk.blue('[   attrsChange ] ') + '@' + permAddr + ', auxId: ' + gad.auxId + ', value: ' + gad.value);
}

function toastInd (msg) {
    ioServer.sendInd('toast', { msg: msg });
}

function getDevInfo (ieeeAddr, eps) {
    var dev = {
            permAddr: ieeeAddr,
            status: shepherd.list(ieeeAddr)[0].status,
            gads: {}
        };

    eps.forEach(function (ep) {
        var gadInfo = getGadInfo(ep);

        if (gadInfo) {
            _.forEach(gadInfo, function (info) {
                dev.gads[info.auxId] = info;
            });
        }
    });

    return dev;
}

function getGadInfo (ep) {
    var epInfo = ep.dump(),
        gadType = getGadType(epInfo),
        gads = [];

    if (!gadType) return;

    _.forEach(gadType, function (gad) {
        var val = ep.clusters.get(gad.cid, 'attrs', gad.rid);

        if (gad.rid === 'measuredValue')
            val = val / 100;
        else if (gad.rid === 'zoneStatus')
            val = getZoneStatus(val).alarm1;

        gads.push({
            type: gad.type,
            auxId: epInfo.epId + '/' + gad.type + '/' + gad.cid + '/' + gad.rid,
            value: val
        });
    });

    return gads;
}

function getGadType (epInfo) {
    var props = [],
        prop = {
            type: null,
            cid: null,
            rid: null
        };

    switch (epInfo.devId) {
        case 0:     // onOffSwitch
        case 1:     // levelControlSwitch
        case 259:   // onOffLightSwitch
        case 260:   // dimmerSwitch
        case 261:   // colorDimmerSwitch
            if (epInfo.clusters.genOnOff) {
                prop.type = 'Switch';
                prop.cid = 'genOnOff';
                prop.rid = 'onOff';
                props.push(prop);
            }
            break;

        case 12:    // simpleSensor
            if (epInfo.clusters.msIlluminanceMeasurement) {
                prop.type = 'Illuminance';
                prop.cid = 'msIlluminanceMeasurement';
                prop.rid = 'measuredValue';
                props.push(prop);
            }
            break;

        case 81:    // smartPlug
            if (epInfo.clusters.genOnOff) {
                prop.type = 'Plug';
                prop.cid = 'genOnOff';
                prop.rid = 'onOff';
                props.push(prop);
            }
            break;

        case 256:   // onOffLight
        case 257:   // dimmableLight
        case 258:   // coloredDimmableLight
            if (epInfo.clusters.genOnOff) {
                prop.type = 'Light';
                prop.cid = 'genOnOff';
                prop.rid = 'onOff';
                props.push(prop);
            }
            break;

        case 770:   // temperatureSensor
            if (epInfo.clusters.msTemperatureMeasurement) {
                props.push({
                    type: 'Temperature',
                    cid: 'msTemperatureMeasurement',
                    rid: 'measuredValue'
                });
            }

            if (epInfo.clusters.msRelativeHumidity) {
                props.push({
                    type: 'Humidity',
                    cid: 'msRelativeHumidity',
                    rid: 'measuredValue'
                });
            }
            break;

        case 1026:  // iasZone
            if (epInfo.clusters.ssIasZone) {
                prop.type = 'Pir';
                prop.cid = 'ssIasZone';
                prop.rid = 'zoneStatus';
                props.push(prop);
            }
            break;

        case 1027:  // iasWarningDevice
            if (epInfo.clusters.genBinaryInput) {
                prop.type = 'Buzzer';
                prop.cid = 'genBinaryInput';
                prop.rid = 'presentValue';
                props.push(prop);
            }
            break;

        default:
            return;
    }

    return props;
}

function getZoneStatus(zoneStatus) {
    var ZONE_STATUS_BITS = [
            'alarm1', 'alarm2', 'tamper', 'battery', 
            'supervisionReports', 'restoreReports', 'trouble', 'ac',
            'reserved1', 'reserved2', 'reserved3', 'reserved4',
            'reserved5', 'reserved6', 'reserved7', 'reserved8'
        ],
        status = {};

    zoneStatus.toString(2).split('').reverse().forEach(function(bit, pos) {
        status[ZONE_STATUS_BITS[pos]] = (bit === '1');
    });

    return status;
}

module.exports = app;
