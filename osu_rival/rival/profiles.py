"""Profile identities read only from the configured private server."""
import json
from urllib.parse import urlsplit
import urllib.request
import urllib.error


def public_url(value):
    if not isinstance(value,str) or len(value)>500:
        raise ValueError('Enter your private server website URL')
    parsed=urlsplit(value.strip())
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
        raise ValueError('Use the server root HTTP URL without credentials')
    try:parsed.port
    except ValueError:raise ValueError('Invalid server port') from None
    return value.strip().rstrip('/')


class Profiles:
    def __init__(self,server_url):self.server_url=server_url.rstrip('/')

    def read(self,path):
        try:
            with urllib.request.urlopen(self.server_url+path,timeout=5) as response:
                raw=response.read(512*1024+1)
                if len(raw)>512*1024:raise ValueError('The server profile response is too large')
                return json.loads(raw)
        except (OSError,ValueError) as error:
            raise ValueError('Could not read private-server profiles. Check that the osu! server is running.') from error

    @staticmethod
    def identity(user):
        if not isinstance(user,dict) or type(user.get('id')) is not int or user['id']<=0 or not isinstance(user.get('username'),str) or not user['username'].strip():
            raise ValueError('The server returned an invalid profile')
        return {'user_id':user['id'],'username':user['username'][:60],'is_bot':bool(user.get('is_bot'))}

    def choices(self):
        # This endpoint lists local users, including bots. It does not fetch upstream users or replays.
        data=self.read('/api/v2/users/')
        if not isinstance(data,dict) or not isinstance(data.get('users'),list):raise ValueError('The server did not return its local profiles')
        return [self.identity(user) for user in data['users'] if isinstance(user,dict) and user.get('id')!=1 and user.get('is_bot') is True]

    def resolve(self,user_id,website_url):
        if type(user_id) is not int or not 1<user_id<=2147483647:raise ValueError('Select an existing server profile; the notification bot is reserved')
        website_url=public_url(website_url)
        local=next((user for user in self.choices() if user['user_id']==user_id),None)
        if local is None:raise ValueError('Select a dedicated bot profile. Regular player accounts cannot be linked to models.')
        user=self.identity(self.read(f'/api/v2/users/{user_id}/osu'))
        if user['user_id']!=user_id:raise ValueError('The server returned a different profile')
        if not user['is_bot']:raise ValueError('Regular player accounts cannot be linked to models')
        return user|{'server_url':self.server_url,'website_url':website_url,'url':f'{website_url}/#/players/{user_id}/osu','mode':'osu'}
