import acorn from 'acorn';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import { attachScopes, makeLegalIdentifier } from 'rollup-pluginutils';
import { flatten, isReference } from './ast-utils.js';
import { HELPERS_ID, PREFIX } from './helpers.js';

var exportsPattern = /^(?:module\.)?exports(?:\.([a-zA-Z_$][a-zA-Z_$0-9]*))?$/;

function deconflict ( identifier, code ) {
	let i = 1;
	let deconflicted = identifier;

	while ( ~code.indexOf( deconflicted ) ) deconflicted = `${identifier}_${i++}`;
	return deconflicted;
}

export default function transform ( code, id, firstpass, sourceMap, ignoreGlobal, namedExports ) {
	if ( !firstpass.test( code ) ) return null;

	let ast;

	try {
		ast = acorn.parse( code, {
			ecmaVersion: 6,
			sourceType: 'module'
		});
	} catch ( err ) {
		err.message += ` in ${id}`;
		throw err;
	}

	const magicString = new MagicString( code );

	let required = {};
	// Because objects have no guaranteed ordering, yet we need it,
	// we need to keep track of the order in a array
	let sources = [];

	let uid = 0;

	let scope = attachScopes( ast, 'scope' );
	let uses = { module: false, exports: false, global: false };

	let scopeDepth = 0;

	const HELPERS_NAME = deconflict( 'commonjsHelpers', code );

	walk( ast, {
		enter ( node, parent ) {
			if ( node.scope ) scope = node.scope;
			if ( /^Function/.test( node.type ) ) scopeDepth += 1;

			if ( sourceMap ) {
				magicString.addSourcemapLocation( node.start );
				magicString.addSourcemapLocation( node.end );
			}

			// Is this an assignment to exports or module.exports?
			if ( node.type === 'AssignmentExpression' ) {
				if ( node.left.type !== 'MemberExpression' ) return;

				const flattened = flatten( node.left );
				if ( !flattened ) return;

				if ( scope.contains( flattened.name ) ) return;

				const match = exportsPattern.exec( flattened.keypath );
				if ( !match || flattened.keypath === 'exports' ) return;

				if ( flattened.keypath === 'module.exports' && node.right.type === 'ObjectExpression' ) {
					return node.right.properties.forEach( prop => {
						if ( prop.computed || prop.key.type !== 'Identifier' ) return;
						const name = prop.key.name;
						if ( name === makeLegalIdentifier( name ) ) namedExports[ name ] = true;
					});
				}

				if ( match[1] ) namedExports[ match[1] ] = true;

				return;
			}

			// To allow consumption of UMD modules, transform `typeof require` to `'function'`
			if ( node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier' ) {
				const name = node.argument.name;

				if ( name === 'require' && !scope.contains( name ) ) {
					magicString.overwrite( node.start, node.end, `'function'` );
					return;
				}
			}

			if ( node.type === 'Identifier' ) {
				if ( ( node.name in uses ) && isReference( node, parent ) && !scope.contains( node.name ) ) {
					uses[ node.name ] = true;
					if ( node.name === 'global' ) magicString.overwrite( node.start, node.end, `${HELPERS_NAME}.commonjsGlobal` );
				}
				return;
			}

			if ( node.type === 'ThisExpression' && scopeDepth === 0 && !ignoreGlobal ) {
				uses.global = true;
				magicString.overwrite( node.start, node.end, `${HELPERS_NAME}.commonjsGlobal`, true );
				return;
			}

			if ( node.type !== 'CallExpression' ) return;
			if ( node.callee.name !== 'require' || scope.contains( 'require' ) ) return;
			if ( node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' ) return; // TODO handle these weird cases?

			const source = node.arguments[0].value;

			let existing = required[ source ];
			if ( existing === undefined ) {
				sources.unshift(source);
			}
			let name;

			if ( !existing ) {
				name = `require$$${uid++}`;
				required[ source ] = { source, name, importsDefault: false };
			} else {
				name = required[ source ].name;
			}

			if ( parent.type !== 'ExpressionStatement' ) {
				required[ source ].importsDefault = true;
				magicString.overwrite( node.start, node.end, name );
			} else {
				// is a bare import, e.g. `require('foo');`
				magicString.remove( parent.start, parent.end );
			}
		},

		leave ( node ) {
			if ( node.scope ) scope = scope.parent;
			if ( /^Function/.test( node.type ) ) scopeDepth -= 1;
		}
	});

	if ( !sources.length && !uses.module && !uses.exports && !uses.global ) {
		if ( Object.keys( namedExports ).length ) {
			throw new Error( `Custom named exports were specified for ${id} but it does not appear to be a CommonJS module` );
		}
		return null; // not a CommonJS module
	}

	const importBlock = [ `import * as ${HELPERS_NAME} from '${HELPERS_ID}';` ].concat(
		sources.map( source => {
			const { name, importsDefault } = required[ source ];
			return `import ${importsDefault ? `${name} from ` : ``}'${PREFIX}${source}';`;
		})
	).join( '\n' );

	const args = `module${uses.exports ? ', exports' : ''}`;

	const wrapperStart = `\n\nexport default ${HELPERS_NAME}.createCommonjsModule(function (${args}) {\n`;
	const wrapperEnd = `\n});`;

	magicString.trim()
		.prepend( importBlock + wrapperStart )
		.trim()
		.append( wrapperEnd );

	code = magicString.toString();
	const map = sourceMap ? magicString.generateMap() : null;

	return { code, map, namedExports };
}