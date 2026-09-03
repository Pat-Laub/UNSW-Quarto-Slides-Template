// reveal.js multiplexing, driven by what this *device* was told to be rather
// than by the URL: multiplex-login.html on the course site stores a role and a
// token in localStorage, and every deck on that origin then picks them up. So
// the presenting iPad and the projector Mac each open the ordinary deck link and
// are already in the right role, with no ids or secrets to carry around.
//
// With no role stored this contacts no server at all, which is how the published
// decks stay ordinary. It does still talk on a BroadcastChannel, which reaches
// no further than this browser's own windows: open the same deck twice and the
// two follow each other with no relay in between and nothing to sign in to.
window.RevealMultiplex = {
	id: 'multiplex',

	// The relay on pikachu, behind a Cloudflare tunnel.
	server: 'https://multiplex.laub.au',

	init: function ( deck ) {
		// The speaker view holds two more copies of this deck in iframes of the
		// same origin -- one of them showing the *next* slide. Left to talk, the
		// upcoming one would tell every window to move on, and the deck would walk
		// itself through to the end.
		if ( window.top !== window.self || /receiver/i.test( location.search ) ) return;

		// A stray device left on last week's deck would otherwise apply this
		// deck's slide indices to different content and look plausible doing it,
		// so every message carries the path it came from.
		var path = location.pathname;

		var EVENTS = [ 'slidechanged', 'fragmentshown', 'fragmenthidden', 'overviewshown',
			'overviewhidden', 'paused', 'resumed' ];

		/* ----------------------- the window next to this one ------------------ */
		// Two windows of the same deck in one browser -- one of them dragged onto an
		// external monitor -- need no relay between them: BroadcastChannel carries
		// the same messages straight across, same origin, same device. Every window
		// both talks and listens, so whichever one you touch is the one that leads
		// and there is nothing to set up or remember.
		//
		// `?mirror` on the end of the address is optional, and only for a window
		// that is being projected: it takes the audience view's bare chrome and
		// stops driving, so a stray click on that screen cannot move the lecture.
		var mirror = false;
		try { mirror = new URLSearchParams( location.search ).has( 'mirror' ); } catch ( e ) {}
		if ( mirror ) document.documentElement.classList.add( 'multiplex-audience' );

		// Whether a message about the wrong deck is worth saying out loud. On a
		// projected screen it is; on someone's second tab it would only be a
		// caption appearing every time they moved in the first one.
		var announce = mirror;

		// Set while a message off the channel is being applied, because applying one
		// moves this deck, and moving this deck is what sends messages. Without it a
		// slide change comes back as an echo a moment after the next one, and the
		// two windows walk backwards over each other.
		var applying = false;

		var channel = null;
		try { if ( window.BroadcastChannel ) channel = new BroadcastChannel( 'reveal-multiplex' ); } catch ( e ) {}

		if ( channel ) {
			// Costs nothing when nothing is listening: postMessage into a channel with
			// no other window on it is a few hundred bytes dropped on the floor, which
			// is cheaper than keeping track of whether a second window exists.
			var broadcast = function ( evt ) {
				if ( applying ) return;
				channel.postMessage( { state: deck.getState(), path: path, content: ( evt || {} ).content } );
			};

			channel.onmessage = function ( e ) {
				if ( !e.data ) return;
				if ( e.data.sync ) {
					if ( mirror ) return;      // a mirror has nothing of its own to answer with
					document.dispatchEvent( new CustomEvent( 'welcome' ) );
					broadcast();
					return;
				}
				applying = true;
				try { apply( e.data, true ); } finally { applying = false; }
			};

			// A window that has just opened asks rather than tells: it adopts the
			// slide and the ink the others are showing, instead of dragging them all
			// back to whatever it happened to load on. Asked again by annotate.js
			// once that has a listener up, since the first answer arrives early.
			var hello = function () { channel.postMessage( { sync: true } ); };
			hello();
			document.addEventListener( 'rejoin', hello );

			if ( !mirror ) {
				EVENTS.forEach( function ( name ) { deck.on( name, broadcast ); } );
				document.addEventListener( 'send', broadcast );
			}
		}

		if ( mirror ) return;                 // and it drives the relay no more than the channel

		/* ----------------------------- the relay ------------------------------ */

		var role, token;
		try {
			role = localStorage.getItem( 'multiplex-role' );
			token = localStorage.getItem( 'multiplex-token' );
		} catch ( e ) { return; }             // storage blocked: behave as an ordinary deck
		if ( ( role !== 'presenter' && role !== 'audience' ) || !token ) return;

		var debug = false;
		try { debug = !!localStorage.getItem( 'multiplex-debug' ); } catch ( e ) {}

		var server = window.RevealMultiplex.server;
		var socket = io.connect( server, {
			query: { token: token, role: role },
			transports: [ 'websocket', 'polling' ]
		} );

		socket.on( 'error', function ( err ) {
			// The token was rejected (expired, or the password has changed).
			if ( String( err ).indexOf( 'unauthorized' ) >= 0 ) notice( 'Multiplex sign-in expired' );
		} );

		if ( role === 'presenter' ) {
			var post = function ( evt ) {
				if ( applying ) return;   // the window this came from has already sent it
				socket.emit( 'state', {
					state: deck.getState(),
					path: path,
					content: ( evt || {} ).content
				} );
			};

			EVENTS.forEach( function ( name ) { deck.on( name, post ); } );
			// Custom events broadcast by the rest of the deck (annotate.js).
			document.addEventListener( 'send', post );

			if ( document.readyState === 'complete' ) post();
			else window.addEventListener( 'load', post );

			// An audience view that joined late has missed every event so far.
			// Resend the state, and let annotate.js resend the whole deck's ink:
			// its 'welcome' handler answers with a full-state message.
			socket.on( 'sync', function () {
				document.dispatchEvent( new CustomEvent( 'welcome' ) );
				post();
			} );

			// Latency readout, on the presenting device only (see probe() below).
			if ( debug ) probe( socket, post );

		} else {
			document.documentElement.classList.add( 'multiplex-audience' );
			announce = true;                  // this screen is the one being projected

			var ask = function () { socket.emit( 'sync' ); };
			socket.on( 'connect', ask );
			document.addEventListener( 'rejoin', ask );

			// Echo the presenter's latency probes back, so it can measure the round
			// trip. Deliberately NOT behind the debug flag: that flag belongs to
			// the device doing the measuring, and requiring it at both ends only
			// means a silent "latency …" that never resolves. Costs nothing when
			// nobody is probing -- the second socket is opened on the first probe
			// and not before. It declares itself a presenter because the relay
			// only forwards `state` from that role; this device holds a valid
			// token, so it is entitled to, and it sends nothing else on it.
			var echo = null;
			socket.on( 'state', function ( m ) {
				if ( !m || !m.probe || m.echo ) return;
				if ( !echo ) {
					echo = io.connect( server, {
						query: { token: token, role: 'presenter' },
						transports: [ 'websocket', 'polling' ]
					} );
				}
				echo.emit( 'state', { probe: m.probe, echo: true } );
			} );

			socket.on( 'state', function ( message ) { apply( message, false ); } );
		}

		/* ---------------------------- following ------------------------------- */
		// Shared by the relay's audience and by a mirror window, which differ only
		// in how the message got here: `local` says it came over the channel, and
		// travelled no further than this device.
		function apply( message, local ) {
			if ( !message ) return;
			if ( message.path && message.path !== path ) {
				if ( announce ) notice( 'Presenter is on ' + deckName( message.path ) );
				return;
			}
			clearNotice();
			if ( message.state && moved( message.state ) ) deck.setState( message.state );
			if ( message.content ) {
				var event = new CustomEvent( 'received' );
				event.content = message.content;
				event.local = local;
				document.dispatchEvent( event );
			}
		}

		// Whether that message is about a slide we are not on. Every ink packet
		// carries the slide it was drawn on, so a stroke sends one of these for
		// every sample the pen takes -- and deck.setState() is not free: reveal
		// rewrites the slide's classes, its fragments, the background and the
		// progress bar whether or not any of them changed. Measured at 5ms a call
		// on a laptop, which at a pen's sampling rate is the entire frame budget
		// spent arriving again on the slide we had not left, and the ink comes
		// through a long way behind the pen. Reading the state back costs nothing
		// by comparison, so ask before telling.
		//
		// Asking the deck rather than remembering what we last applied also means
		// a window that has been moved by hand is put back by the next message.
		function moved( state ) {
			var here = deck.getState();
			return state.indexh !== here.indexh || state.indexv !== here.indexv ||
				state.indexf !== here.indexf ||
				!!state.paused !== !!here.paused || !!state.overview !== !!here.overview;
		}

		/* --------------------------- latency readout --------------------------- */
		// How long the audience takes to see what you just did. Measured as a
		// round trip -- presenter to relay to audience, and back the same way --
		// so it needs no agreement between the two devices' clocks, which would
		// otherwise swamp a number this small. One way is about half of it.
		//
		// Shown only on the presenting device, and only when the login page's
		// "show latency" box is ticked: the audience screen is projected.
		function probe( socket, post ) {
			var pending = null, samples = [];

			var pill = document.createElement( 'div' );
			pill.style.cssText = 'position:fixed;left:8px;top:8px;z-index:60;padding:3px 9px;' +
				'border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font:12px/1.4 ui-monospace,monospace;' +
				'pointer-events:none;white-space:pre';
			pill.textContent = 'latency …';
			document.body.appendChild( pill );

			socket.on( 'state', function ( m ) {
				if ( !m || !m.echo || !pending || m.probe !== pending ) return;
				var rtt = Date.now() - pending;
				pending = null;
				samples.push( rtt );
				if ( samples.length > 20 ) samples.shift();

				var sorted = samples.slice().sort( function ( a, b ) { return a - b; } );
				var median = sorted[ Math.floor( sorted.length / 2 ) ];
				var worst = sorted[ sorted.length - 1 ];
				pill.textContent = 'one-way ~' + Math.round( median / 2 ) + 'ms' +
					'   (round trip ' + rtt + 'ms, median ' + median + ', worst ' + worst + ')';
			} );

			setInterval( function () {
				// Skip a beat rather than queue up when one goes unanswered.
				if ( pending && Date.now() - pending < 4000 ) return;
				pending = Date.now();
				socket.emit( 'state', { probe: pending } );
			}, 1000 );
		}

		/* ------------------------- the audience notice ------------------------- */
		// Deliberately small and quiet: this view is on a projector.

		var box;
		function notice( text ) {
			if ( !box ) {
				box = document.createElement( 'div' );
				box.className = 'multiplex-notice';
				document.body.appendChild( box );
			}
			box.textContent = text;
			box.style.display = 'block';
		}
		function clearNotice() { if ( box ) box.style.display = 'none'; }
		function deckName( p ) {
			return decodeURIComponent( p.split( '/' ).pop() || '' ).replace( /\.slides\.html$/, '' );
		}
	}
};
