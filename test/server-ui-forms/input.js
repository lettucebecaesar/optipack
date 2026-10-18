// Differential coverage for @minecraft/server-ui through the harness mock.
import { world, system } from '@minecraft/server';
import { ActionFormData, MessageFormData, uiManager } from '@minecraft/server-ui';

function onTick(player) {
  const menu = new ActionFormData()
    .title('Main Menu')
    .body('Choose an option')
    .button('Play')
    .button('Settings');
  menu.show(player);

  if (player.location.y > 64) {
    const notice = new MessageFormData()
      .title('Notice')
      .body('You are high up')
      .button1('OK')
      .button2('Dismiss');
    uiManager.showPlayer(player, notice);
  }
}

world.afterEvents.worldLoad.subscribe(() => {
  system.runInterval(() => onTick(world.getAllPlayers()[0]), 1);
});
