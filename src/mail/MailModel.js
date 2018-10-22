//@flow
import m from "mithril"
import stream from "mithril/stream/stream.js"
import {neverNull} from "../api/common/utils/Utils"
import {createMoveMailData} from "../api/entities/tutanota/MoveMailData"
import {load, loadAll, serviceRequestVoid} from "../api/main/Entity"
import {TutanotaService} from "../api/entities/tutanota/Services"
import {HttpMethod, isSameId} from "../api/common/EntityFunctions"
import {PreconditionFailedError} from "../api/common/error/RestError"
import {Dialog} from "../gui/base/Dialog"
import {logins} from "../api/main/LoginController"
import {getTrashFolder, isFinalDelete} from "./MailUtils"
import {createDeleteMailData} from "../api/entities/tutanota/DeleteMailData"
import {MailBoxTypeRef} from "../api/entities/tutanota/MailBox"
import {MailboxGroupRootTypeRef} from "../api/entities/tutanota/MailboxGroupRoot"
import {GroupInfoTypeRef} from "../api/entities/sys/GroupInfo"
import {GroupTypeRef} from "../api/entities/sys/Group"
import {MailFolderTypeRef} from "../api/entities/tutanota/MailFolder"
import {FeatureType, GroupType, MailFolderType, OperationType} from "../api/common/TutanotaConstants"
import {module as replaced} from "@hot"
import {UserTypeRef} from "../api/entities/sys/User"
import {locator} from "../api/main/MainLocator"
import {MailTypeRef} from "../api/entities/tutanota/Mail"
import type {EntityUpdateData} from "../api/main/EntityEventController"
import {isUpdateForTypeRef} from "../api/main/EntityEventController"
import * as Notifications from "../gui/Notifications"
import {lang} from "../misc/LanguageViewModel"

export type MailboxDetail = {
	mailbox: MailBox,
	folders: MailFolder[],
	mailGroupInfo: GroupInfo,
	mailGroup: Group
}

class MailModel {
	mailboxDetails: Stream<MailboxDetail[]>
	_initialization: ?Promise<void>

	constructor() {
		this.mailboxDetails = stream([])
		this._initialization = null

		locator.entityEvent.addListener((updates) => {
			this.entityEventsReceived(updates)
		})
	}

	init(): Promise<void> {
		if (this._initialization) {
			return this._initialization
		}

		let mailGroupMemberships = logins.getUserController().getMailGroupMemberships()
		this._initialization = Promise.all(mailGroupMemberships.map(mailGroupMembership => {
			return Promise.all([
				load(MailboxGroupRootTypeRef, mailGroupMembership.group)
					.then(mailGroupRoot => load(MailBoxTypeRef, mailGroupRoot.mailbox)),
				load(GroupInfoTypeRef, mailGroupMembership.groupInfo),
				load(GroupTypeRef, mailGroupMembership.group)
			]).spread((mailbox, mailGroupInfo, mailGroup) => {
				return this._loadFolders(neverNull(mailbox.systemFolders).folders, true).then(folders => {
					return {
						mailbox,
						folders,
						mailGroupInfo,
						mailGroup
					}
				})
			})
		})).then(details => {
			this.mailboxDetails(details)
		}).return()
		return this._initialization
	}

	_loadFolders(folderListId: Id, loadSubFolders: boolean): Promise<MailFolder[]> {
		return loadAll(MailFolderTypeRef, folderListId).then(folders => {
			if (loadSubFolders) {
				return Promise.map(folders, folder => this._loadFolders(folder.subFolders, false)).then(subfolders => {
					return folders.concat(...subfolders)
				})
			} else {
				return folders
			}
		}).then(folders => {
			return folders.filter(f => {
				if ((f.folderType === MailFolderType.SPAM || f.folderType === MailFolderType.ARCHIVE)
					&& !logins.isInternalUserLoggedIn()) {
					return false
				} else if (logins.isEnabled(FeatureType.InternalCommunication)
					&& f.folderType === MailFolderType.SPAM) {
					return false
				} else {
					return true
				}
			})
		})
	}

	getMailboxDetails(mail: Mail): MailboxDetail {
		return this.getMailboxDetailsForMailListId(mail._id[0])
	}

	getMailboxDetailsForMailListId(mailListId: Id): MailboxDetail {
		return neverNull(this.mailboxDetails().find((md) => md.folders.find(f => f.mails === mailListId) != null))
	}

	getMailboxDetailsForMailGroup(mailGroupId: Id): MailboxDetail {
		return neverNull(this.mailboxDetails().find((md) => mailGroupId === md.mailGroup._id))
	}

	getUserMailboxDetails(): MailboxDetail {
		let userMailGroupMembership = logins.getUserController().getUserMailGroupMembership()
		return neverNull(this.mailboxDetails().find(md => md.mailGroup._id === userMailGroupMembership.group))
	}

	getMailboxFolders(mail: Mail): MailFolder[] {
		return this.getMailboxDetails(mail).folders
	}

	getMailFolder(mailListId: Id): ?MailFolder {
		for (let e of this.mailboxDetails()) {
			for (let f of e.folders) {
				if (f.mails === mailListId) {
					return f
				}
			}
		}
		return null
	}

	moveMails(mails: Mail[], target: MailFolder): Promise<void> {
		let moveMails = mails.filter(m => m._id[0] !== target.mails && target._ownerGroup === m._ownerGroup) // prevent moving mails between mail boxes.
		if (moveMails.length > 0) {
			let moveMailData = createMoveMailData()
			moveMailData.targetFolder = target._id
			moveMailData.mails.push(...mails.map(m => m._id))
			return serviceRequestVoid(TutanotaService.MoveMailService, HttpMethod.POST, moveMailData)
				.catch(PreconditionFailedError, e => Dialog.error("operationStillActive_msg"))
		}
		return Promise.resolve()
	}

	/**
	 * Finally deletes the given mails if they are already in the trash or spam folders, otherwise moves them to the trash folder.
	 * A deletion confirmation must have been show before.
	 */
	deleteMails(mails: Mail[]): Promise<void> {
		let groupedMails = mails.reduce((all, mail) => {
			isFinalDelete(mailModel.getMailFolder(mail._id[0])) ? all.trash.push(mail) : all.move.push(mail)
			return all
		}, {trash: [], move: []})

		let promises = []
		if (groupedMails.trash.length > 0) {
			let deleteMailData = createDeleteMailData()
			deleteMailData.mails.push(...groupedMails.trash.map(m => m._id))
			promises.push(serviceRequestVoid(TutanotaService.MailService, HttpMethod.DELETE, deleteMailData)
				.catch(PreconditionFailedError, e => Dialog.error("operationStillActive_msg")))
		}
		if (groupedMails.move.length > 0) {
			promises.push(mailModel.moveMails(groupedMails.move, getTrashFolder(mailModel.getMailboxFolders(groupedMails.move[0]))))
		}
		return Promise.all(promises).return()
	}

	entityEventsReceived(updates: $ReadOnlyArray<EntityUpdateData>): void {
		for (let update of updates) {
			if (isUpdateForTypeRef(MailFolderTypeRef, update)) {
				this._initialization = null
				this.init().then(() => m.redraw())
			} else if (isUpdateForTypeRef(GroupInfoTypeRef, update)) {
				if (update.operation === OperationType.UPDATE) {
					this._initialization = null
					this.init().then(() => m.redraw())
				}
			} else if (isUpdateForTypeRef(UserTypeRef, update)) {
				if (update.operation === OperationType.UPDATE && isSameId(logins.getUserController().user._id, update.instanceId)) {
					load(UserTypeRef, update.instanceId).then(updatedUser => {
						let newMemberships = updatedUser.memberships
						                                .filter(membership => membership.groupType === GroupType.Mail)
						let currentDetails = this.mailboxDetails()
						if (newMemberships.length !== currentDetails.length) {
							this._initialization = null
							this.init().then(() => m.redraw())
						}
					})
				}
			} else if (isUpdateForTypeRef(MailTypeRef, update) && update.operation === OperationType.CREATE) {
				if (this._getInboxIds().indexOf(update.instanceListId) !== -1) {
					// If we don't find another operation on this email in the batch, then it should be a create operation
					const isCreateBatch = updates.find(u =>
						isUpdateForTypeRef(MailTypeRef, u) && u.instanceId === update.instanceId && u.operation !== OperationType.CREATE) == null
					if (isCreateBatch) {
						this._showNotification(update)
					}
				}
			}
		}
	}

	_showNotification(update: EntityUpdateData) {
		Notifications.showNotification(lang.get("newMails_msg"), null, () => {
			m.route.set(`/mail/${update.instanceListId}/${update.instanceId}`)
			window.focus()
		})
	}

	_getInboxIds(): Array<Id> {
		return this
			.mailboxDetails()
			.map(m => {
				const inbox = m.folders.find(f => f.folderType === MailFolderType.INBOX)
				if (inbox) {
					return inbox.mails
				} else {
					return null
				}
			})
			.filter(Boolean) // this tells flow that result is non-null
	}
}

export const mailModel = new MailModel()

if (replaced) {
	Object.assign(mailModel, replaced.mailModel)
}




