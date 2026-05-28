import { Hono } from 'hono'
import { cors } from 'hono/cors'
import commentsRoutes from './routes/comments'
import groupsRoutes from './routes/groups'
import resourcesRoutes from './routes/resources'
import systemRoutes from './routes/system'
import backupsRoutes from './routes/backups'

const app = new Hono()

app.use('*', cors())

app.route('/', systemRoutes)
app.route('/resources', resourcesRoutes)
app.route('/comments', commentsRoutes)
app.route('/groups', groupsRoutes)
app.route('/backups', backupsRoutes)

export default app
