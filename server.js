var express = require('express');
var bcrypt = require('bcrypt');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var mongoose = require('mongoose');
var mongoStore = require('connect-mongodb');
var flash = require('connect-flash');
var io = require('socket.io');

// Some consts
var DEFAULT_RATING = 1000;

// Database constants
var DB_NAME = 'mydb';
var DB_URL = 'mongodb://localhost/' + DB_NAME;

// HEROKU STUFF
var port = process.env.PORT || 8000;
var DB_URL = process.env.MONGOHQ_URL || DB_URL;

// Set up the database
var db = mongoose.createConnection(DB_URL);
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function() {
    console.log('Connected to database');
    app.use(express.session({ 
        store: new mongoStore({
            db: mongoose.connection.db
        }),
        secret: 'pvptd'
    }));

    var http = require('http');
    var server = http.createServer(app);

    sio = io.listen(server, {log: false});
    server.listen(port);

    sio.sockets.on('connection', function(conn) {
        conn.on('init', function(id) {
            Matchmaker.register(id, conn);
        });
    });

});

var UserSchema = new mongoose.Schema({
    username: {type: String, required: true, unique: true},
    salt: {type: String, required: true},
    hash: {type: String, required: true},
    rating: {type: Number, required: true}
});

UserSchema
.virtual('password')
.get(function () {
    return this._password;
})
.set(function (password) {
    this._password = password;
    var salt = this.salt = bcrypt.genSaltSync(10);
    this.hash = bcrypt.hashSync(password, salt);
});

UserSchema.method('verifyPassword', function(password, callback) {
    bcrypt.compare(password, this.hash, callback);
});

UserSchema.static('authenticate', function(username, password, callback) {
    this.findOne({ username: username }, function(err, user) {
        if (err) { return callback(err); }
        if (!user) { return callback(null, false); }
        user.verifyPassword(password, function(err, passwordCorrect) {
            if (err) { return callback(err); }
            if (!passwordCorrect) { return callback(null, false); }
            return callback(null, user);
        });
    });
});

var User = db.model('User', UserSchema);

// Setup passport
passport.use(new LocalStrategy(
    function(username, password, done) {
        User.authenticate(username, password, function(err, user) {
            return done(err, user);
        });
    }
));

passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    User.findById(id, function (err, user) {
        done(err, user);
    });
});

var app = module.exports = express();
global.app = app;

app.configure(function() {
    app.use(express.cookieParser());
    app.use(express.bodyParser());
    app.use(express.methodOverride());
    app.use(express.session({ secret: 'pvptd' }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(flash());
    app.use(app.router);
});

app.get('/', function(req, res) { 
    res.sendfile(__dirname + '/index.html');
});

app.get('/logout', function(req, res) {
    req.logout();
    res.redirect('index.html');
});

app.get('/*', function(req, res) {
    if (req.user !== undefined){
        res.cookie('id', req.user.id);
        res.cookie('username', req.user.username);
        res.cookie('rating', req.user.rating);
    }
    else {
        res.cookie('id', 'none');
    }
    var file = req.params[0]; 
    res.sendfile(__dirname + '/' + file);
});

app.post('/login', passport.authenticate('local', { successRedirect: '/main.html',
                                                    failureRedirect: '/index.html?err=1', 
                                                    failureFlash: true }
));

app.post('/register', function(req, res) {
    var username = req.body.username;
    if(username == '') {
        res.redirect('/register.html?err=2'); 
        return;
    }
    var password = req.body.password;
    var verify = req.body.verify;
    if(password == '') {
        res.redirect('/register.html?err=4');
        return;
    }
    if(password != verify) {
        res.redirect('/register.html?err=1');
        return;
    }


    var newUser = new User({
        username: username,
        password: password,
        rating: DEFAULT_RATING
    });

    User.find({username: username}, function (err, users) {
        if(err) {
            throw err;
        }
        if(users.length > 0) {
            res.redirect('/register.html?err=3');
            return;
        }
        newUser.save(function(err) {
            if(err) {
                throw err;
            }
        });
        res.redirect('/index.html?err=2');
    });
});

//var Matchmaker = require('./js/Matchmaker').Matchmaker;


var GameServer = require('./js/GameServer');

// Matchmaking code
var Matchmaker = {
    IDLE: 0,
    FINDING: 1,
    FOUND: 2,
    CONFIRMED: 3,
    PLAYING: 4,

    candidates: [],

    clients: {},

    games: {},

    match: function() {
        console.log(Matchmaker.candidates);
        console.log(Matchmaker.clients);
        while(Matchmaker.candidates.length > 1) {
            var ps = Matchmaker.candidates.splice(0, 2);
            var p1 = ps[0];
            var p2 = ps[1];
            if(p1 === p2) {
                Matchmaker.candidates.unshift(p1);
                continue;
            }
            // Check validity of status
            if(Matchmaker.clients[p1] === undefined ||
               Matchmaker.clients[p1].status !== Matchmaker.FINDING) {
                Matchmaker.candidates.unshift(p2);
                continue;
            }
            if(Matchmaker.clients[p2] === undefined ||
               Matchmaker.clients[p2].status !== Matchmaker.FINDING) {
                Matchmaker.candidates.unshift(p1);
                continue;
            }
            var g = new Game(p1, p2);
            Matchmaker.clients[p1].foundGame();
            Matchmaker.clients[p2].foundGame();
            Matchmaker.games[p1] = g;
            Matchmaker.games[p2] = g;
            g.init();
        }
    },

    register: function(id, conn) {
        var cli = Matchmaker.clients[id];
        if(cli === undefined) {
            cli = new Client(id, conn);
            Matchmaker.clients[id] = cli;
        } else {
            cli.conn.emit('dc');
            cli.conn = conn;
        }
        console.log(Matchmaker.games);
        if(Matchmaker.games[id] !== null && Matchmaker.games[id] !== undefined) {
            if(Matchmaker.games[id].status == GameStatus.PLAYING) {
                cli.status = Matchmaker.PLAYING;
                if(Matchmaker.games[id].p1 === id) {
                    conn.emit('in game', 1);
                    Matchmaker.games[id].setConn(1, conn);
                } else {
                    conn.emit('in game', 2);
                    Matchmaker.games[id].setConn(2, conn);
                }
            } else {
                // clear waiting game
            }
        }
        conn.on('disconnect', cli.disconnect.bind(cli));
        conn.on('match cancel', cli.stopSearch.bind(cli));
        conn.on('start search', cli.startSearch.bind(cli));
        conn.on('spectate', function(id) {
            if(Matchmaker.games[id] === undefined) {
                conn.emit('fail spectate');
                return;
            }
            Matchmaker.games[id].server.addSpectator(conn);
        });
    },

    sendGameList: function() {
        var gamelist = {};
        var num = 0;
        for(var i in Matchmaker.games) {
            if(num  == 10) {
                break;
            }
            var g = Matchmaker.games[i];
            if(g.status !== GameStatus.PLAYING) {
                continue;
            }
            if(gamelist[g.p1] === undefined && gamelist[g.p2] === undefined) {
                gamelist[g.p1] = {p1: Matchmaker.clients[g.p1].username, p2: Matchmaker.clients[g.p2].username};
                num++;
            }
        }
        for(var i in Matchmaker.clients) {
            var c = Matchmaker.clients[i];
            if(c.status !== Matchmaker.PLAYING) {
                c.conn.emit("gamelist", gamelist);
            }
        }
    }
};

var GameStatus = {CONFIRMING: 0, PLAYING: 1};

function Game(p1, p2) {
    this.p1 = p1;
    this.p2 = p2;
    this.status = GameStatus.CONFIRMING;
}

Game.prototype.init = function() {
    this.askConfirmation();
};

Game.prototype.askConfirmation = function() {
    Matchmaker.clients[this.p1].conn.on('match confirmation', function() {
        Matchmaker.clients[this.p1].status = Matchmaker.CONFIRMED;
        if(Matchmaker.clients[this.p2].status === Matchmaker.CONFIRMED) {
            this.startGame();
        }
    }.bind(this));
    Matchmaker.clients[this.p2].conn.on('match confirmation', function() {
        Matchmaker.clients[this.p2].status = Matchmaker.CONFIRMED;
        if(Matchmaker.clients[this.p1].status === Matchmaker.CONFIRMED) {
            this.startGame();
        }
    }.bind(this));
    Matchmaker.clients[this.p1].conn.emit('match confirmation');
    Matchmaker.clients[this.p2].conn.emit('match confirmation');
};

Game.prototype.startGame = function() {
    // Notify clients that game is starting
    Matchmaker.clients[this.p1].conn.emit('start', 1);
    Matchmaker.clients[this.p2].conn.emit('start', 2);
    Matchmaker.clients[this.p1].status = Matchmaker.PLAYING;
    Matchmaker.clients[this.p2].status = Matchmaker.PLAYING;

    this.status = GameStatus.PLAYING;
    this.server = new GameServer(Matchmaker.clients[this.p1].conn, Matchmaker.clients[this.p2].conn, this.endGame.bind(this), Matchmaker.clients[this.p1].username, Matchmaker.clients[this.p2].username);
};

Game.prototype.endGame = function(winner) {
    if(winner === 1) {
        User.findById(this.p1, function(err, user1) {
            User.findById(this.p2, function(err, user2) {
                var delta = 10 + parseInt(Math.abs(user1.rating - user2.rating) / 100);
                user2.rating -= delta;
                if(user2.rating < 0) {
                    user2.rating = 0;
                }
                user1.rating += delta;
                user2.save(function(err) {
                    if(err) {
                        throw err;
                    }
                });
                user1.save(function(err) {
                    if(err) {
                        throw err;
                    }
                });
            }.bind(this));
        }.bind(this));
    } else {
        User.findById(this.p1, function(err, user1) {
            User.findById(this.p2, function(err, user2) {
                var delta = 10 + parseInt(Math.abs(user1.rating - user2.rating) / 100);
                user1.rating -= delta;
                if(user1.rating < 0) {
                    user1.rating = 0;
                }
                user2.rating += delta;
                user2.save(function(err) {
                    if(err) {
                        throw err;
                    }
                });
                user1.save(function(err) {
                    if(err) {
                        throw err;
                    }
                });
            }.bind(this));
        }.bind(this));
    }
    Matchmaker.clients[this.p1].status = Matchmaker.IDLE;
    Matchmaker.clients[this.p2].status = Matchmaker.IDLE;
    delete Matchmaker.games[this.p1];
    delete Matchmaker.games[this.p2];
};

Game.prototype.otherPlayer = function(id) {
    if(this.p1 == id) {
        return this.p2;
    }
    return this.p1;
}

Game.prototype.setConn = function(player, conn) {
    this.server.setConn(player, conn);
}


function Client(id, conn) {
    this.id = id;
    this.conn = conn;
    this.status = Matchmaker.IDLE;
    this.username = null;
    User.findById(id, function(err, user) {
        this.username = user.username;
    }.bind(this));
}

Client.prototype.foundGame = function() {
    this.status = Matchmaker.FOUND;
};

Client.prototype.startSearch = function() {
    if(this.status != Matchmaker.IDLE) {
        return;
    }
    this.status = Matchmaker.FINDING;
    Matchmaker.candidates.push(this.id);
};

Client.prototype.stopSearch = function() {
    var idx = Matchmaker.candidates.indexOf(this.id);
    if(idx != -1) {
        Matchmaker.candidates.splice(idx, 1);
    }
    if(this.status == Matchmaker.FOUND ||
       this.status == Matchmaker.CONFIRMED) {
        this.status = Matchmaker.IDLE;
        var otherid = Matchmaker.games[this.id].otherPlayer(this.id);
        var other = Matchmaker.clients[otherid];
        if(other !== undefined) {
            other.status = Matchmaker.IDLE;
            other.conn.emit('fail');
            other.stopSearch();
        }
    }
    this.status = Matchmaker.IDLE;
};

Client.prototype.disconnect = function() {
    if(this.status !== Matchmaker.PLAYING) {
        this.stopSearch();
    }
    if(Matchmaker.clients[this.id] !== undefined) {
        Matchmaker.clients[this.id].conn.emit('disconnect');
        if(Matchmaker.clients[this.id].status !== Matchmaker.PLAYING) {
            delete Matchmaker.clients[this.id];
        }
    }
};


// Set up matches every second
setInterval(Matchmaker.match, 1000);
// Send all non-playing clients a list of games to watch
setInterval(Matchmaker.sendGameList, 10000);
