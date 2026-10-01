/**
 * @license Copyright (c) 2003-2015, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or http://ckeditor.com/license
 */

CKEDITOR.editorConfig = function( config ) {
	// Define changes to default configuration here.
	// For complete reference see:
	// http://docs.ckeditor.com/#!/api/CKEDITOR.config

	// The toolbar groups arrangement, optimized for a single toolbar row.
	config.toolbarGroups = [
		{ name: 'document', groups: [ 'mode', 'document', 'doctools' ] },
		{ name: 'styles', groups: [ 'styles' ] },
		{ name: 'colors', groups: [ 'colors' ] },
		{ name: 'clipboard', groups: [ 'clipboard', 'undo' ] },
		{ name: 'editing', groups: [ 'find', 'selection', 'spellchecker', 'editing' ] },
		{ name: 'forms', groups: [ 'forms' ] },
		{ name: 'basicstyles', groups: [ 'basicstyles', 'cleanup' ] },
		{ name: 'paragraph', groups: [ 'indent', 'list', 'blocks', 'align', 'bidi', 'paragraph' ] },
		{ name: 'links', groups: [ 'links' ] },
		{ name: 'insert', groups: [ 'insert' ] },
		{ name: 'tools', groups: [ 'tools' ] },
		{ name: 'others', groups: [ 'others' ] },
		{ name: 'about', groups: [ 'about' ] }
	];

	// The default plugins included in the basic setup define some buttons that
	// are not needed in a basic editor. They are removed here.
	config.removeButtons = 'Cut,Copy,Paste,Undo,Redo,Anchor,Subscript,Superscript,Font,BGColor,Outdent,Indent';

	// Language
	config.defaultLanguage = "zh-cn"
	config.language = "zh-cn"

	// Dialog windows are also simplified.
	config.removeDialogTabs = 'link:advanced';

	// Colors, from React Color Picker - Compact
	config.colorButton_colors = ["4D4D4D", "999999", "FFFFFF", "F44E3B", "FE9200", "FCDC00", "DBDF00", "A4DD00", "68CCCA", "73D8FF", "AEA1FF", "FDA1FF", "333333", "808080", "cccccc", "D33115", "E27300", "FCC400", "B0BC00", "68BC00", "16A5A5", "009CE0", "7B64FF", "FA28FF", "000000", "666666", "B3B3B3", "9F0500", "C45100", "FB9E00", "808900", "194D33", "0C797D", "0062B1", "653294", "AB149E"].join(',')
};
