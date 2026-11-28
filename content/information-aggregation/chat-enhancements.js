/**
 * chat-enhancements.js
 * Enhancements for Hattrick chats (league, match, federation, national team, tournament)
 * @author LA-maczek
 */

'use strict';

/**
 * @typedef {'League'|'Match'|'Federation'|'NationalTeam'|'Tournament'|'SupporterWeekTrophy'}
 *   ChatType
 * @typedef ChatInfo
 * @prop {ChatType} type
 * @prop {number}   seriesId LeagueLevelUnitID for a league chat, 0 otherwise or if not found
 */

Foxtrick.modules.ChatEnhancements = {
	MODULE_CATEGORY: Foxtrick.moduleCategories.INFORMATION_AGGREGATION,
	PAGES: [
		'series', 'match', 'federation', 'worldCup', 'arenaHubTournament', 'supporterWeekTrophy',
	],
	OPTIONS: [[
		'TeamNameTooltip',
		'TeamNameTooltipLeague', 'TeamNameTooltipMatch',
		'TeamNameTooltipFederation', 'TeamNameTooltipNationalTeam',
		'TeamNameTooltipTournament', 'TeamNameTooltipSupporterWeekTrophy',
	]],

	/** @param {document} doc */
	run: function(doc) {
		if (!Foxtrick.Prefs.isModuleOptionEnabled(this, 'TeamNameTooltip'))
			return;

		let chat = this.getChat(doc);
		if (chat && Foxtrick.Prefs.isModuleOptionEnabled(this, 'TeamNameTooltip' + chat.type))
			this.addTeamNameTooltips(doc, chat);
	},

	/** @param {document} doc */
	change: function(doc) {
		this.run(doc);
	},

	/**
	 * Detect which chat is shown on the page.
	 *
	 * The match page shows the league chat for a league match
	 * and the match chat for other matches (cup, friendly...). The chat header then holds the series name
	 * (e.g. '(II.1)') or the team names (e.g. '(Home - Away)').
	 *
	 * @param  {document} doc
	 * @return {ChatInfo}     null if there is no chat
	 */
	getChat: function(doc) {
		// series names: 'I', 'II.1', 'IV.56'...
		const SERIES_NAME_RE = /^[IVXL]+(\.\d+)?$/;

		let box = doc.querySelector('#content .chat-box');
		if (!box)
			return null;

		/** @type {[string, ChatType][]} */
		const PAGE_TYPES = [
			['federation', 'Federation'],
			['worldCup', 'NationalTeam'],
			['arenaHubTournament', 'Tournament'],
			['supporterWeekTrophy', 'SupporterWeekTrophy'],
		];
		for (let [page, type] of PAGE_TYPES) {
			if (Foxtrick.isPage(doc, page))
				return { type, seriesId: 0 };
		}

		let label = box.querySelector('h2 .smallerText');
		let name = label ? label.textContent.trim().replace(/^\(|\)$/g, '').trim() : '';
		let isLeagueChat = SERIES_NAME_RE.test(name);

		if (Foxtrick.isPage(doc, 'match') && !isLeagueChat)
			return { type: 'Match', seriesId: 0 };

		// league chat: on the series page or on a league match page
		let seriesId = 0;
		if (isLeagueChat) {
			// series link with the same text as the chat header, e.g. <a href="…">II.1</a>
			/** @type {NodeListOf<HTMLAnchorElement>} */
			let links = doc.querySelectorAll('#content a[href*="LeagueLevelUnitID" i]');
			let link = Foxtrick.nth(a => a.textContent.trim() === name, links);
			if (link)
				seriesId = Foxtrick.util.id.getLeagueLeveUnitIdFromUrl(link.href) || 0;
		}
		if (!seriesId && Foxtrick.isPage(doc, 'series')) {
			let header = Foxtrick.Pages.All.getMainHeader(doc);
			seriesId = Foxtrick.util.id.findLeagueLeveUnitId(header) || 0;
		}

		return { type: 'League', seriesId };
	},

	/**
	 * Add the team name(s) as a tooltip to manager links (avatar and name)
	 * in chat messages.
	 *
	 * In a league chat, teams of the series come from a single leaguedetails call.
	 * Other authors (all authors in other chats, or old league chat messages
	 * after promotion/relegation) are looked up with teamdetails by userId.
	 *
	 * @param {document} doc
	 * @param {ChatInfo} chat
	 */
	addTeamNameTooltips: function(doc, chat) {
		const module = this;
		const DONE_CLASS = 'ft-chat-team';
		// only Hattrick's own avatar and name links; TeamPopupLinks inserts its popup
		// menu (with userId links too) into the message, so a broad selector would catch it
		const LINK_SELECTOR = [
			`ht-chat-message .chat-bubble-pre a[href*="userId="]:not(.${DONE_CLASS})`,
			`ht-chat-message a.chat-message-user[href*="userId="]:not(.${DONE_CLASS})`,
		].join(', ');

		/** @type {NodeListOf<HTMLAnchorElement>} */
		let links = doc.querySelectorAll(LINK_SELECTOR);
		if (!links.length)
			return;

		let userIds = Foxtrick.unique(Foxtrick.map(a => Foxtrick.util.id.getUserIdFromUrl(a.href),
			links).filter(Boolean));
		if (!userIds.length)
			return;

		/**
		 * @param  {CHPPParams} args
		 * @return {Promise<CHPPXML>}
		 */
		let retrieve = function(args) {
			return new Promise((resolve) => {
				Foxtrick.util.api.retrieve(doc, args, { cache: 'session' }, (xml, errorText) => {
					if (!xml || errorText) {
						Foxtrick.log('ChatEnhancements: no XML', args, errorText);
						resolve(null);
						return;
					}
					resolve(xml);
				});
			});
		};

		/**
		 * @param  {CHPPParams[]} batchArgs
		 * @return {Promise<CHPPXML[]>}
		 */
		let batchRetrieve = function(batchArgs) {
			/** @type {CHPPOpts} */
			let opts = { cache: 'session' };
			return new Promise((resolve) => {
				Foxtrick.util.api.batchRetrieve(doc, batchArgs, opts, (xmls, errors) => {
					if (!xmls) {
						resolve([]);
						return;
					}
					for (let [i, error] of (errors || []).entries()) {
						if (error)
							Foxtrick.log('ChatEnhancements: no XML', batchArgs[i], error);
					}
					resolve(xmls);
				});
			});
		};

		/**
		 * Get names of active teams owned by the user in teamdetails:
		 * only teams from the given country if there are any (all teams otherwise),
		 * primary club first.
		 * @param  {CHPPXML} xml
		 * @param  {number}  leagueId country of the series, 0 = no country filter
		 * @return {string[]}
		 */
		let getUserTeamNames = function(xml, leagueId) {
			let teamsNode = xml.node('Teams');
			if (!teamsNode)
				return [];

			let teams = [];
			for (let team of teamsNode.children) {
				if (team.nodeName !== 'Team' || xml.bool('IsDeactivated', team))
					continue;

				let league = xml.node('League', team);
				teams.push({
					name: xml.text('TeamName', team),
					leagueId: league ? xml.num('LeagueID', league) : 0,
					isPrimary: xml.bool('IsPrimaryClub', team),
				});
			}

			let local = leagueId ? teams.filter(t => t.leagueId === leagueId) : [];
			let shown = local.length ? local : teams;
			shown.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

			return shown.map(t => t.name).filter(Boolean);
		};

		/** @param {Map<number, string[]>} names */
		let applyTooltips = function(names) {
			/** @type {NodeListOf<HTMLAnchorElement>} */
			let current = doc.querySelectorAll(LINK_SELECTOR);
			if (!current.length)
				return;

			Foxtrick.stopObserver(doc);
			try {
				for (let link of current) {
					let teamNames = names.get(Foxtrick.util.id.getUserIdFromUrl(link.href));
					if (!teamNames || !teamNames.length)
						continue;

					Foxtrick.addClass(link, DONE_CLASS);
					if (link.title)
						continue; // keep Hattrick's own tooltip

					link.title = teamNames.join(', ');
					Foxtrick.makeFeaturedElement(link, module);
				}
			}
			finally {
				Foxtrick.startObserver(doc);
			}
		};

		let { seriesId } = chat;

		/** @type {Promise<CHPPXML>} */
		let leaguePromise = Promise.resolve(null);
		if (seriesId) {
			leaguePromise = retrieve([
				['file', 'leaguedetails'],
				['version', '1.6'],
				['leagueLevelUnitID', seriesId],
			]);
		}

		leaguePromise.then(async (leagueXml) => {
			// CHPP unavailable: do not try further calls
			if (seriesId && !leagueXml)
				return;

			/** @type {Map<number, string[]>} */
			let names = new Map();

			// country of the series; 0 = show all teams of an author
			let leagueId = 0;

			if (leagueXml) {
				leagueId = leagueXml.num('LeagueID');
				for (let team of leagueXml.getElementsByTagName('Team')) {
					let userId = leagueXml.num('UserId', team);
					let teamName = leagueXml.text('TeamName', team);
					if (!userId || !teamName)
						continue;

					// a user may exceptionally own more than one team in a series
					let list = names.get(userId) || [];
					list.push(teamName);
					names.set(userId, list);
				}
			}

			let missing = userIds.filter(id => !names.has(id));
			if (missing.length) {
				/** @type {CHPPParams[]} */
				let batchArgs = missing.map(id => [
					['file', 'teamdetails'],
					['version', '4.0'],
					['userId', id],
				]);

				let xmls = await batchRetrieve(batchArgs);
				for (let [i, xml] of xmls.entries()) {
					if (!xml)
						continue;

					let teamNames = getUserTeamNames(xml, leagueId);
					if (teamNames.length)
						names.set(missing[i], teamNames);
				}
			}

			applyTooltips(names);
		}).catch(Foxtrick.catch(module));
	},
};
