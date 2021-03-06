var express = require('express');
var router = express.Router();
var request = require('request'); // "Request" library
var cookieParser = require('cookie-parser');

var config = require('../config');

var client_id = config.spotifyClientId; // Your client id
var client_secret = config.spotifySecret; // Your client secret
var redirectTemplate = 'http://[host]/setlister/'; // Your redirect uri
var stateKey = 'spotify_auth_state';
var cookieParser = require('cookie-parser');
var querystring = require('querystring');
var xml2js = require('xml2js');

var mongo = require('mongoskin');
var Db = mongo.Db;
var MongoClient = mongo.MongoClient;
var db = MongoClient.connect('mongodb://localhost:27017/setlist2playlist');
var searchesColl = db.collection('setlistSearches');


var generateRandomString = function(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};


/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index');
});

//about page
router.get('/about', function(req, res, next) {
  res.render('about');
});

router.get('/login', function(req, res) {

  var state = generateRandomString(16);
  res.cookie(stateKey, state);

    var redirectUri = redirectTemplate.replace("[host]", req.get('host'));
    
  // your application requests authorization
  var scope = 'user-read-private user-read-email user-follow-read playlist-modify playlist-modify-public playlist-modify-private';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirectUri,
      state: state
    }));
});

router.get('/refreshToken', function(req, res){
    var access_token = req.body.spotify_refresh_token;
    var refresh_token = req.cookies.spotify_refresh_token;
    
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        refresh_token: refresh_token,
        grant_type: 'refresh_token'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };
    
    request.post(authOptions, function(error, response, body) {
        console.log(body);
      if (!error && response.statusCode === 200) {

        var access_token = body.access_token;
        var expires_in = body.expires_in;
        
        var dateToExpire = new Date();
        dateToExpire.setSeconds(dateToExpire.getSeconds() + expires_in); 
            
        res.cookie('spotify_access_token', access_token, { expires: dateToExpire });

        res.status(200).send('token refreshed');
      } else {
          console.log(error);
      }
    });
});

router.get('/setlister', function(req, res) {
  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;
  var redirectUri = redirectTemplate.replace("[host]", req.get('host'));

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
      console.log('clearing cookie');
        res.clearCookie(stateKey);

    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {

        var access_token = body.access_token;
        var refresh_token = body.refresh_token;
        
        var expires_in = body.expires_in;
        
        var dateToExpire = new Date();
        dateToExpire.setSeconds(dateToExpire.getSeconds() + expires_in); 
        var daysExpiration = 14;
        var refreshTokenExpiration = new Date();
        refreshTokenExpiration.setSeconds(refreshTokenExpiration.getSeconds() + (3600 * 24 * 5));
            
        res.cookie('spotify_access_token', access_token, { expires: dateToExpire });
        res.cookie('spotify_refresh_token', refresh_token, { expires: refreshTokenExpiration } );

        // we can also pass the token to the browser to make requests from there
        res.redirect('/');
      } else {
        res.redirect('/#' +
          querystring.stringify({
            error: 'invalid_token'
          }));
      }
    });
  }
});

router.get('/getArtist', function(req, res) {
    var bandName = req.query.artist;
    // bandName = encodeURIComponent(bandName);

    var bandUriTemplate = "http://api.setlist.fm/rest/0.1/search/artists.json?artistName=[band]";
    var bandQuery = bandUriTemplate.replace("[band]", bandName);

    request(bandQuery, function(error, response, body) {
        if (response.statusCode === 401){
            //TODO: refresh the token
            
            request(bandQuery, function(error, response, body) {
                res.json(body);        
            });
            
        }
        
        res.json(body);
    });
});


router.get('/getSetlist', function(req, res) {
    console.log('hit /getSetlist');
    var template = "http://api.setlist.fm/rest/0.1/artist/[id]/setlists.xml";
    var requestUrl = template.replace("[id]", req.query.id);

    request(requestUrl, function (error, response, body) {
        
        xml2js.parseString(body, function (err, result) {
            console.log(result);
            var setlists = [];
            
            if (!result || !result.setlists || !result.setlists.setlist) {
                res.send(setlists);
                return;
            }

            for (var i = 0; i < result.setlists.setlist.length; i++) {
                var xmlSetlist = result.setlists.setlist[i];
                console.log(xmlSetlist);
                var setlist = {};
                
                if (xmlSetlist.$.eventDate != null)
                    setlist.when = xmlSetlist.$.eventDate;

                if (xmlSetlist.venue != null)
                    setlist.where = xmlSetlist.venue[0].$.name;
                setlist.songs = [];
                
                if (!xmlSetlist.sets || !xmlSetlist.sets[0].set)
                    continue;

                for (var j = 0; j < xmlSetlist.sets[0].set.length; j++) {

                    var xmlSet = xmlSetlist.sets[0].set[j];

                    for (var k = 0; k < xmlSet.song.length; k++) {
                        var song = xmlSet.song[k];
                        
                        var setlistSong = {};
                        
                        if (song.$.name) {
                            setlistSong.name = song.$.name;
                            setlist.songs.push(setlistSong);
                        }
                    }
                }

                setlists.push(setlist);
            }

            res.send(setlists);
        });
    });
});

router.get('/getSpotifySong', function(req, res){
    console.log('trying to get cookies from these playlists: ' + req.cookies);
    
    var access_token = req.cookies["spotify_access_token"];
    
    var options = {
        url: 'https://api.spotify.com/v1/me/following?type=artist',
        headers: { 'Authorization': 'Bearer ' + access_token },
        json: true
    };
    
    request.get(options, function (error, response, body) {
        //TODO: need to parse xml this
        res.send(body);

        //xml2js.parseString(body, function(err, result) {

        //};
    });
});

router.get('/searchSetlistfmArtist', function (req, res) {
    var bandName = req.query.artist;
    searchesColl.insert( { artistName: decodeURI(bandName), when: Date() });

    var bandUriTemplate = "http://api.setlist.fm/rest/0.1/search/artists.xml?artistName=[band]";
    var bandQuery = bandUriTemplate.replace("[band]", bandName);
    
    request(bandQuery, function (error, response, body) {
        xml2js.parseString(body, function (err, result) {
            var artists = [];
            
            if (!result || !result.artists || !result.artists.artist)
                return artists;

            for (var i = 0; i < result.artists.artist.length; i++) {
                var entry = result.artists.artist[i];
                var createdArtist =  {
                                    name: entry.$.name,
                                    setlistfmId: entry.$.mbid
                            };
                artists.push(createdArtist);
            }
            
            var matchesPrecisely = null;
            
            for (var j = 0; j < artists.length; j++) {
                var artist = artists[j];
                
                if (artist.name.toLowerCase() === bandName.toLowerCase()){
                    matchesPrecisely = artist;
                }
            }
            
            if (matchesPrecisely != null){
                artists.splice(artists.indexOf(matchesPrecisely), 1);
                artists.splice(0, 0, matchesPrecisely);
            }
            
            res.send(artists);
        });
    });
});

module.exports = router;


