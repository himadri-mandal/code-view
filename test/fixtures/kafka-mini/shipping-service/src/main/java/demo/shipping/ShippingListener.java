package demo.shipping;

import org.springframework.kafka.annotation.DltHandler;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.annotation.RetryableTopic;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.stereotype.Component;

@Component
public class ShippingListener {
  private final ShippingService shipping;

  public ShippingListener(ShippingService shipping) {
    this.shipping = shipping;
  }

  @RetryableTopic(attempts = "3")
  @KafkaListener(topics = "${app.topics.orders}", groupId = "${shipping.group}")
  @SendTo("shipments")
  public String onOrder(OrderMessage message) {
    return shipping.ship(message);
  }

  @DltHandler
  public void dead(OrderMessage message) {
    System.err.println("dead " + message);
  }
}
